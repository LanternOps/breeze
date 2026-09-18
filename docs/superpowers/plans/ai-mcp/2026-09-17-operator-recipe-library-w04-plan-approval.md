---
tracking_issue: LanternOps/breeze#6165
---

# Operator Recipe Library — Wave E4: Plan approval and the `effect` step kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One four-eyes decision authorizes an ordered, digest-pinned SET of provider effects instead of eighteen. A recipe's `buildPlan` output is written to `ai_operator_plan_approvals` + `ai_operator_plan_approval_effects`, hashed into an `effect_set_digest` by the SAME canonicalizer `action_intents.argument_digest` uses, and carried by exactly ONE action intent whose tool name is `operator_plan` — Tier 3, four-eyes, executing nothing. Releasing that intent marks the plan `approved` and wakes the task. Thereafter the coordinator dispatches each effect as its own child action intent, `decided_via = 'plan_approval'`, admitted at release only if `(task_id, plan_revision, ordinal, argument_digest)` is a member of the approved set **read from rows**, the approval is still `approved`, the task's `revision` still equals the approval's `plan_revision`, and the effect's tool is inside the admitting agent's frozen policy snapshot allowlist. Every effect is dispatched `probe → write → probe`: a pre-probe that already observes the desired end state settles the operation `succeeded` with `result.noop = true` and dispatches no write at all.

**Architecture:** Two new Shape-1 tables in one DDL migration; the effect SET lives in **child rows**, never in a jsonb blob and never as a recomputed digest, because membership is checked at release and a release-time check must read the same rows an approver's card was rendered from. A new pure module `packages/shared/src/canonicalize/effectSet.ts` builds the digest envelope and is pinned by frozen vectors beside the existing canonicalizer corpus. Three new API service modules, all under `apps/api/src/services/aiOperator/`: `planApproval.ts` (propose / mark approved / supersede / `bumpPlanRevision` / the one membership predicate), `effectDispatch.ts` (probe → mint child intent → probe, the `effect` and `probe` step kinds' coordinator halves) and `effectProbes/` (the provider-neutral `EffectProbe` registry plus the Google probe family). `operator_plan` is registered as a real tool everywhere `m365_disable_user` is, plus an `EFFECT_DIGEST_RESOLVERS` entry that re-hashes the approved effect ROWS at release — so a plan mutated under a live approval fails `digest_mismatch` before anything is dispatched. `createActionIntent` gains a tool-allowlist **ceiling** (the piece PR #6110's site ceiling deliberately leaves open) and one narrow `planApproval` branch; `revalidateApprovedIntentForRelease` gains a `decided_via = 'plan_approval'` arm modelled exactly on the shipped `script_reviewer` lane arm.

**Tech Stack:** TypeScript, Hono, Drizzle ORM + hand-written SQL migrations (forced RLS, PostgreSQL 16), Zod, Vitest (unit + `vitest.integration.config.ts` against real Postgres), React/Astro (`apps/web`), React Native (`apps/mobile`).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md` — §5.4 (`ai_operator_plan_approvals`), §6.4 (plan approval, verbatim), §6.6 (probe → write → probe, idempotency classes, `verified_resolved`), §6.1 step-kind table rows `effect` ("reserve operation → pre-write probe → mint or attach intent → dispatch via release worker") and `probe` ("run the verification adapter"), §11 risk row *"Plan approval becomes a four-eyes bypass"*, §10 row **E4**. Builds on `docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md` §6.5 (per-effect operation identity), §7.1 ("existing approvals only authorize their pinned arguments"), §7.3 (dispatch claim), §13 ("Failed/inconclusive verification cannot produce 'Resolved'").

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-operator-recipe-library/wave-<subissue#>`.

---

## Decisions recorded for the orchestrator

Each is a place where the wave brief, the spec, or the obvious design does not survive contact with the shipped code. The executor must **not** "fix" these back.

### D-E4-1 — Child effects are MINTED AS ACTION INTENTS (brief option (a)), not dispatched headlessly from the coordinator

Evidence, all first-hand:

- `jobs/intentReleaseWorker.ts:1236-1328` is the only durable dispatcher. It resolves a tool name through `GOOGLE_HEADLESS_SECRET_ACTIONS` → `revalidation.tenantTool` → `isHeadlessGoogleTool` → `isHeadlessM365Tool` → `executeTool`. Option (b) would need a second copy of that ladder.
- At-most-once for a **task-linked** intent is `claimTaskLinkedIntentForDispatch` (`services/aiOperator/dispatchClaim.ts:154`), one conditional UPDATE that CASes `approved → executing` *and* flips the operation row to `dispatched` in the same transaction, under the lock order task → operation → intent. Option (b) has no CAS and would have to invent one.
- Secret handling is `sealToolSecrets` / `sealActionResultSecrets` / `assertNoPlaintextSecret` at `jobs/intentReleaseWorker.ts:1354-1436`, keyed on `action_intents.result`. An effect dispatched outside an intent has no `result` column to seal into.
- `reserveOperation` (`services/aiOperator/operationService.ts:91`) is already called from **inside** `createActionIntent` (`services/actionIntents/intentService.ts:2110-2132`) in the same transaction as the intent insert, so the permanent `ai_operator_operations_org_task_op_uq` index on `(org_id, task_id, operation_key)` already gives the replay guarantee spec §11 asks for — for free, and only on this path.
- The audit trail (`recordActionIntentEvent`, `metrics.ts`) and the approval-card provenance columns only exist on `action_intents`.

Option (b) would have to reimplement five shipped mechanisms to gain nothing. Decision: **(a)**.

### D-E4-2 — Both the plan intent and every child effect intent are HUMAN-shaped, and `task` context becomes legal for a human principal **only** when `planApproval` accompanies it

Two facts about `createActionIntent` decide this wave's whole shape.

**Fact 1 — an `ai_agent` principal requires a live run.** `intentService.ts:1322-1412` loads the run from `auth.principal` and throws `ActionIntentError('agent_run_invalid')` when it is missing. The coordinator dispatching an approved plan is **not inside a model run** — §6.2 is explicit that "Discovery reads are coordinator-issued tool calls, not model-chosen". So neither the plan intent nor a child effect intent can be an agent intent.

**Fact 2 — `task` context is agent-principal-only**, `intentService.ts:1124-1132`:

```ts
if (input.task !== undefined) {
  if (auth.principal.kind !== 'ai_agent') {
    throw new ActionIntentError(
      `task context is only valid for the ai_agent principal (got principal '${auth.principal.kind}')`,
      'task_context_not_allowed',
    );
  }
```

and, further down, `intentService.ts:1415-1430`: 

```ts
if (taskContext) {
  if (agentRun.taskId !== taskContext.taskId || agentRun.taskStepKey !== taskContext.taskStepKey) {
    throw new ActionIntentError(
      'Task context does not match the calling run\'s own task linkage',
      'task_context_invalid',
    );
  }
}
```

```ts
if (taskContext) {
  if (agentRun.taskId !== taskContext.taskId || agentRun.taskStepKey !== taskContext.taskStepKey) {
    throw new ActionIntentError(
      'Task context does not match the calling run\'s own task linkage',
      'task_context_invalid',
    );
  }
}
```

That run-linkage cross-check lives **inside** the `ai_agent` branch, so with a human principal it never runs at all. The only thing standing between a human-shaped intent and a task context is the one `throw` in Fact 2.

Three options were weighed:

1. **Open a synthetic `ai_agent_runs` row per effect step.** Rejected: `createAndEnqueueAgentRun` (`services/aiAgents/runService.ts`, called at `taskCoordinator.ts:345`) enqueues a model job. A run row with no model call makes `ai_agent_runs` mean two different things and silently distorts every per-run cost and concurrency metric.
2. **A new principal kind.** Rejected: `actionIntentOriginPrincipalKindEnum` (`db/schema/actionIntents.ts:76-89`) is pinned by `originPrincipal.test.ts` against `PrincipalKind`; a new principal kind is an auth-surface change far larger than this wave.
3. **ADOPTED — relax exactly one condition.** `CreateActionIntentInput` gains `planApproval?: { approvalId: string; ordinal: number }`. The Fact-2 throw becomes "agent principal **or** `planApproval` present", and when `planApproval` is present the service performs a **stronger, row-backed** substitution for the run-linkage proof, read in the same transaction: the approval row must be `state = 'approved'`, its `plan_revision` must equal the live `ai_operator_tasks.revision`, and `(ordinal, tool_name, argument_digest)` must match one `ai_operator_plan_approval_effects` row. That is exactly the substitution the shipped `script_reviewer` lane already makes at release (`revalidateRelease.ts:275-283`: *"the lane substitutes a STRONGER proof: a typed evidence blob that revalidates against current policy, proposal, review, circuit, authority and device state"*), so both the precedent and its shape exist.

**Who each intent is minted as:**

| Intent | Principal / source | `task` ctx | `planApproval` | `requested_by_user_id` |
|---|---|---|---|---|
| `operator_plan` (one per plan revision) | human, rebuilt for `ai_operator_tasks.requester_user_id`; `source: 'mcp_api'` | **no** — it reserves no operation and dispatches nothing | no | the task's requester |
| child effect (one per ordinal) | human, rebuilt for the plan approval's `approved_by_user_id`; `source: 'mcp_api'` | yes | yes | the plan's approver |

Consequences, all deliberate and all load-bearing:

- **Requester-cannot-self-approve comes for free and unchanged.** The plan intent's requester is the technician who started the task, so `intentService.ts:1652`'s `eligibleAll.filter((userId) => userId !== requesterId)` excludes them from the four-eyes fan-out exactly as for any other intent, and the sole-operator step-up path (`decideApprovalRequest.ts:1057-1083`, assurance level ≥ 3) applies with no new code. Task 13 proves both.
- **A child effect EXECUTES under the approver's live authority.** `revalidateApprovedIntentForRelease` branch (c) rebuilds their `AuthContext` (`actorContext.ts`'s `buildAuthContextForIntent`) and branch (e)'s human arm runs `checkToolPermission(actionName, arguments, auth)` (`revalidateRelease.ts:425-431`). An approver who loses `m365:execute`, loses org access, or is deactivated between approval and release fails closed with `rbac_denied` / `actor_invalid`. Spec §6.4's "attributed to the plan approval's approver" becomes a live authorization fact, not merely an audit string.
- **A task with no human requester cannot get a plan approved.** `ai_operator_tasks.requester_user_id` is nullable (`db/schema/aiOperatorTasks.ts`, `origin_kind ∈ 'schedule' | 'alert' | 'anomaly' | 'sweep'`). `proposePlanApproval` refuses with `no_requester` and the coordinator hands the task off. That is the correct behaviour for an identity recipe — a plan that destroys a person's access needs a named human on both ends — and it is asserted in Task 6.
- **`origin_principal_kind` stays whatever the rebuilt human context yields**; the agent's authorship is recorded on the task and its events, not smuggled into the intent's principal columns.
- Task 7 Step 1 makes the executor **grep the creating migration for `action_intents` attribution CHECKs** before writing the branch. The shape used here (requester set, run null, `source = 'mcp_api'`) is the ordinary MCP-caller shape and is already legal; if a CHECK has since been added that conflicts, stop and report rather than editing a shipped migration.

### D-E4-3 — The approved effect SET is CHILD ROWS (`ai_operator_plan_approval_effects`), not jsonb and not a recomputed digest

The brief recommends this and the code agrees twice over. (a) `CORE_TENANT_EXPORT_POLICY` forces **any** `jsonb` column to `excludedOpen` (CLAUDE.md, tenancy section) — an effect set stored as jsonb would be dropped from a GDPR tenant export, and the effect list is the record of what was done to a person. (b) A membership check that recomputes the digest from `buildPlan` would be a self-consistency check: `buildPlan` is deterministic, so it would always agree with itself and would never catch a plan that changed. Membership is read from rows, and `effect_set_digest` is a second, independent seal over those same rows.

### D-E4-4 — `operator_plan` gets a REAL `EFFECT_DIGEST_RESOLVERS` entry, not a `DELIBERATELY_UNPINNED` exemption

`effectDigestCoverage.contract.test.ts` requires every four-eyes surface to resolve to an `EFFECT_DIGEST_RESOLVERS` entry or carry a written reason. Every existing M365/Google entry is exempted as `EXTERNAL` ("pinning it would require a Graph round trip at intent creation"). `operator_plan` is the opposite case: everything it references is a local row. Its resolver re-reads `ai_operator_plan_approval_effects` for `(task_id, plan_revision)` and returns the canonical ordered list as material, so `computeEffectDigestForRelease` (`effectDigest.ts:685`) catches a plan whose rows changed under a live approval and the release fails `digest_mismatch` before `revalidatePlanApprovalMembership` even runs. Two independent seals over the same rows, which is the correct posture for the primitive that grants four-eyes authority to a set.

### D-E4-5 — The tool-allowlist ceiling is NEW work in this wave; PR #6110 adds the SITE ceiling, not this one

Read at planning time: `gh pr view 6110` (OPEN, *"no cross-site or cross-role overreach through AI tools — site axis + route-parity permissions (#6086)"*). Its `createActionIntent` change is a **site** ceiling ("A site-restricted user cannot raise the intent (`createActionIntent`, the one function every raise path uses)") plus `orgWideGovernanceTools.ts` / `orgWideGovernanceCoverage.contract.test.ts`. It does not check the admitting agent's `toolAllowlist`. Spec §6.4's last line — *"`createActionIntent` needs a ceiling check that a plan intent cannot name a tool the admitting agent's snapshot does not allow — the same ceiling PR #6110 adds for single tier-3 intents; confirm its final shape before E4"* — is therefore **confirmed as not-yet-shipped**, and Task 7 adds it as a sibling gate immediately after #6110's site gate, reusing its placement and its refusal style. If #6110 has merged by execution time, rebase onto it and put the allowlist check directly below the site check in the same block; if it has not, put it where the site check will go and leave a comment naming #6110.

### D-E4-6 — The probe registry returns `observedAt: Date`; W05's `probeM365Effect` returns `observedAt: string`, and the M365 adapter converts

`docs/superpowers/plans/ai-mcp/2026-09-17-operator-recipe-library-w05-m365-write-catalog.md:63-69` ships:

```ts
export type M365EffectProbeState = 'satisfied' | 'unsatisfied' | 'unknown';
export interface M365EffectProbeResult { state: M365EffectProbeState; observedAt: string; detail: string }
export interface M365EffectProbeContext { orgId: string; effectRequestedAt: Date; actorId?: string }
export function probeM365Effect(
  actionId: M365WriteActionId, args: M365WriteAction, ctx: M365EffectProbeContext,
): Promise<M365EffectProbeResult>;
```

It is keyed by **action id**, not tool name, and its `observedAt` is an ISO string. The provider-neutral registry this wave defines is keyed by **tool name** and uses `Date` (the brief's signature, and the type every other timestamp in `aiOperator/` uses). Task 9 ships a thin adapter that maps tool name → action id via `M365_HEADLESS_ACTIONS` (`services/m365ToolsHeadless.ts:24`) and `new Date(result.observedAt)`. **If `services/m365ControlPlane/effectProbes.ts` does not exist when Task 9 runs (M1 has not merged), the adapter registers nothing for M365 tool names and the registry's `unknown` default applies** — which by §6.6 means handoff, never a false `verified`. That is the correct degradation and the wave ships without M1.

### D-E4-7 — Three of the eight Google probes are honestly `unknown`, and that is the finding, not a gap

Verified against `services/aiToolsGoogle.ts` and `services/googleClient.ts`:

| Tool | Probe | Basis |
|---|---|---|
| `google_suspend_user` | `satisfied` iff `users.get(...).data.suspended === true` | `aiToolsGoogle.ts:240-260` already reads exactly this field |
| `google_remove_from_group` | `satisfied` iff the group is absent from `groups.list({ userKey })` | mirrors `googleListUserGroupsHandler`, `aiToolsGoogle.ts:372-392` |
| `google_remove_license` | `satisfied` iff no assignment for `(productId, skuId, userId)` | mirrors `googleListLicensesHandler`, `aiToolsGoogle.ts:519-541` |
| `google_set_vacation` | `satisfied` iff `users.settings.getVacation(...).enableAutoReply === true` and the message matches | Gmail read on the same impersonated client `googleSetVacationAction` writes with (`aiToolsGoogle.ts:869-899`) |
| `google_set_forwarding` | `satisfied` iff `getAutoForwarding()` is `{ enabled: true, emailAddress: forwardTo }` **and** the forwarding address's `verificationStatus === 'accepted'` | the write path already refuses an unverified destination (`aiToolsGoogle.ts:791-800`); the probe must hold the same bar or it would certify mail that never forwards |
| `google_add_mail_delegate` | `satisfied` iff `delegates.list()` contains the delegate with `verificationStatus === 'accepted'` | no existing helper; new read on the same client |
| `google_signout` | **always `unknown`** | the Directory user resource exposes no session-validity field. `lastLoginTime` is not one. |
| `google_wipe_mobile_device` | `satisfied` iff every device that `resolveWipeTarget`'s query would return reports `status` in `('WIPING','WIPED')`; `unknown` when the list is empty | `aiToolsGoogle.ts:135` shows the exact `mobiledevices.list({ customerId: 'my_customer', query: 'email:'+primaryEmail })` call and the exact-match gate the probe must repeat |

`google_signout` returning `unknown` means an offboarding that includes it can never reach `verified_resolved` until a better signal exists. That is the honest answer and it matches the M365 precedent W05 already took for `m365.user.reset_password` (*"a password reset has no observable end state"*). It is recorded as a follow-up in Task 17, not papered over.

### D-E4-8 — Wave-conflict containment with W03 (human-work)

W03 also edits `taskCoordinator.ts`. Every line this wave adds to the coordinator lives in **two new files** (`services/aiOperator/planApproval.ts`, `services/aiOperator/effectDispatch.ts`) and reaches the coordinator through exactly **three** added lines: two imports and one `case` arm per step kind in the `advanceTask` switch (`taskCoordinator.ts:435-448`). No existing coordinator function is edited, the three invariants at `taskCoordinator.ts:7-40` are untouched, and `admitReasoningRun`'s `bumpPlanRevision: boolean` parameter (`taskCoordinator.ts:302-345`) keeps its name and meaning — this wave's exported `bumpPlanRevision()` is a different, separately-named function in `planApproval.ts` and the plan says so at its definition site.

---

## File Structure

**packages/shared**
- Create `src/canonicalize/effectSet.ts` — `PlannedEffectForDigest`, `canonicalizeEffectSet`, `computeEffectSetDigest`.
- Create `src/canonicalize/effectSet.test.ts`.
- Modify `src/canonicalize/vectors.ts` — append `EFFECT_SET_VECTORS` with frozen digests.
- Create `src/canonicalize/effectSet.vectors.test.ts`.
- Modify `src/types/aiOperator.ts` — `AI_OPERATOR_PLAN_APPROVAL_STATES`, `AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES`, `AiOperatorPlanApprovalDto`, `AiOperatorPlanEffectDto`.
- Modify `package.json` exports map only if `./canonicalize/effectSet` is not already covered by the existing `./canonicalize/*` subpath — Task 2 Step 1 checks.

**apps/api — data**
- Create `migrations/2026-10-19-100000-ai-operator-plan-approvals.sql` (DDL only, writes no rows).
- Create `src/db/schema/aiOperatorPlanApprovals.ts`; modify `src/db/schema/index.ts` (export after `./aiOperatorTaskGraph`).
- Modify `src/services/tenantCascade.ts` — `CORE_ORG_CASCADE_DELETE_ORDER` ×2.
- Modify `src/services/tenantExportPolicyRegistry.ts` — two new tables.
- Modify `src/services/orgMergeRegistry.ts` — two new dispositions.

**apps/api — the `operator_plan` tool registration sweep**
- Modify `src/services/aiToolsAiOperator.ts` (**new file**) + `src/services/aiTools.ts` (register it), `src/services/aiAgentSdkTools.ts` (`TOOL_TIERS`), `src/services/aiGuardrails.ts` (`TIER3_FOUR_EYES_TOOLS`, `TOOL_PERMISSIONS`, `AGENT_HUMAN_ONLY_TOOLS`, `buildApprovalDescription`), `src/services/aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY`), `src/services/actionIntents/effectDigest.ts` (`EFFECT_DIGEST_RESOLVERS`), `apps/web/src/components/ai-risk/tierConfig.ts`.

**apps/api — services**
- Create `src/services/aiOperator/planApproval.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/effectDispatch.ts` (+ `.test.ts`).
- Create `src/services/aiOperator/effectProbes/index.ts` (+ `.test.ts`), `effectProbes/m365.ts`, `effectProbes/google.ts` (+ `google.test.ts`).
- Modify `src/services/actionIntents/intentService.ts` — allowlist ceiling + the `planApproval` branch.
- Modify `src/services/actionIntents/revalidateRelease.ts` — the `plan_approval` arm.
- Modify `src/services/aiOperator/taskCoordinator.ts` — **two imports and two switch arms, nothing else**.

**apps/api — integration tests (all under `src/__tests__/integration/`)**
- `aiOperatorPlanApprovalRls.integration.test.ts`
- `aiOperatorPlanApprovalMembership.integration.test.ts`
- `aiOperatorEffectDispatchReplay.integration.test.ts`

**apps/web**
- Create `src/components/approvals/OperatorPlanApprovalCard.tsx` (+ `.test.tsx`).
- Modify `src/components/approvals/ApprovalsInbox.tsx` — the MOUNT.
- Modify `src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/approvals.json`.

**apps/mobile**
- Modify `src/services/approvals.ts` + the approval detail screen.

---

## Global Constraints

- **Rigor: high, adversarial.** This wave changes how Tier-3 four-eyes approval is granted. Every task is red-first. Task 13's three adversarial integration suites are the acceptance gate and run against real Postgres as `breeze_app` where the assertion is about RLS.
- **Flag:** everything stays behind `AI_OPERATOR_TASKS_ENABLED` (`aiOperatorTasksEnabled()`, `apps/api/src/config/env.ts`). **No new env var** — `.env.example`, `deploy/.env.example`, both compose files and `envComposeParity.test.ts` are untouched.
- **Assume E1 and E2 have landed.** Consume, never redefine: `RecipeDefinition`, `PlannedEffect { ordinal, toolName, provider, targetId, accountExternalId, canonicalArguments }`, `DiscoveryFacts`, `getRecipe(workflowKey, workflowVersion)` (`services/aiOperator/recipes/`); `aiOperatorTaskTargets`, `aiOperatorTaskTargetAccounts`, `aiOperatorTaskSteps`, `aiOperatorTaskEvents` (`db/schema/aiOperatorTaskGraph.ts`); `openStep`, `markStepWaiting`, `settleStep`, `resolveStepKind` (`stepService.ts`); `appendTaskEvent`, `TaskEventActor` (`eventService.ts`); `createTaskTarget`, `freezeTargetAccount` (`targetService.ts`). If any is missing at execution time, E1/E2 has not merged — **stop and report**, never invent a local copy.
- **Tenancy ceremony (spec §5 preamble).** Both new tables are Shape 1: `org_id uuid NOT NULL REFERENCES organizations(id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, four `breeze_org_isolation_{select,insert,update,delete}` policies using `public.breeze_has_org_access(org_id)`, **in the creating migration**. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — no allowlist entry, and neither table ever enters `INTENTIONAL_UNSCOPED`.
- **`text` + CHECK, never `pgEnum`** (Operator spec §11.1). Every value list is mirrored by an exported `as const` array in the Drizzle schema **and** in `packages/shared`, pinned by `enumParity.test.ts`.
- **Every composite FK referencing an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`.** Org merge runs `SET CONSTRAINTS ALL DEFERRED`; a non-deferrable one aborts it with 23503 (`orgLifecycleFoundations.integration.test.ts`, "merge contract").
- **Migration naming.** The newest committed migration at planning time is `2026-10-17-140000-snmp-metrics-instance-width.sql`; W02 adds `2026-10-18-100000` and `2026-10-18-100100`. This wave uses `2026-10-19-100000-ai-operator-plan-approvals.sql`. **Task 3 Step 1 re-runs `ls apps/api/migrations/*.sql | sort | tail -1` and renames if anything newer landed.** Idempotent throughout (`CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`, `DO $$ … EXCEPTION WHEN duplicate_object`). **No inner `BEGIN`/`COMMIT`.** Never edit a shipped migration.
- **The DDL migration writes NO rows**, so it needs no `breeze.scope` election and `migrationRlsScope.test.ts` stays green by construction. **Never add a new file to that test's frozen 122-offender baseline.**
- **Cascade / export / merge registration is mechanical, not a judgement call** (Task 4). It has shipped broken or reddened CI five times (#1359, #1351, #1365, #2179, #2514); review caught it 0/5, the contract tests 5/5.
- **Tests:** file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` — **never** `pnpm --filter … test -- --run <path>` (pnpm forwards the literal `--`, vitest swallows `--run` as a positional and runs the whole 1,470-file suite in watch mode). Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at the repo root; `pnpm test-stack down` when finished — nothing does this for you). Integration tests MUST live under `apps/api/src/__tests__/integration/` — a wrongly placed one runs ZERO tests and reads green. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. **A 0-test run is a stall, not a pass** — always read the reported file/test counts.
- **Commits:** one per task, every message ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Final task opens the PR with `Closes #<wave sub-issue>` and **STOPS** — never merge, never `--admin`.

---

### Task 1: Shared value lists and DTOs

**Files:**
- Modify: `packages/shared/src/types/aiOperator.ts` (append at end of file)
- Create: `packages/shared/src/types/aiOperatorPlanApproval.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AI_OPERATOR_PLAN_APPROVAL_STATES`, `AiOperatorPlanApprovalState`, `AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES`, `AiOperatorEffectIdempotencyClass`, `AiOperatorPlanEffectDto`, `AiOperatorPlanApprovalDto`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/aiOperatorPlanApproval.test.ts
/**
 * Recipe Library spec §5.4 and §6.6. These lists are asserted as VALUES, not
 * only as types: each is mirrored by a CHECK constraint in
 * 2026-10-19-100000-ai-operator-plan-approvals.sql and by an `as const` array
 * in the Drizzle schema, and `enumParity.test.ts` diffs all three. A type-only
 * union cannot be diffed against a CHECK.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES,
  AI_OPERATOR_PLAN_APPROVAL_STATES,
} from './aiOperator';

describe('plan-approval value lists', () => {
  it('AI_OPERATOR_PLAN_APPROVAL_STATES is exactly spec §5.4, in its order', () => {
    expect(AI_OPERATOR_PLAN_APPROVAL_STATES).toEqual([
      'pending', 'approved', 'rejected', 'expired', 'superseded',
    ]);
  });

  it('AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES is exactly spec §6.6', () => {
    expect(AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES).toEqual([
      'idempotent', 'idempotent_by_probe', 'non_idempotent',
    ]);
  });

  it('both lists are frozen, so a caller cannot widen one by push()', () => {
    expect(Object.isFrozen(AI_OPERATOR_PLAN_APPROVAL_STATES)).toBe(true);
    expect(Object.isFrozen(AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd packages/shared && npx vitest run src/types/aiOperatorPlanApproval.test.ts`
Expected: FAIL — `AI_OPERATOR_PLAN_APPROVAL_STATES` is not exported from `./aiOperator`.

- [ ] **Step 3: Append to `packages/shared/src/types/aiOperator.ts`**

```ts
/**
 * `ai_operator_plan_approvals.state` (Recipe Library spec §5.4).
 *
 * `superseded` is NOT a variant of `rejected`: nobody refused this plan, the
 * plan itself stopped existing when `ai_operator_tasks.revision` moved. Keeping
 * them apart is what lets the task page say "the plan changed, re-approve"
 * instead of "an approver said no", and it is the state the release-time
 * membership check refuses on (spec §6.4: "Any change … bumps `revision`,
 * supersedes the approval, and requires a new one").
 */
export const AI_OPERATOR_PLAN_APPROVAL_STATES = Object.freeze([
  'pending', 'approved', 'rejected', 'expired', 'superseded',
] as const);
export type AiOperatorPlanApprovalState = (typeof AI_OPERATOR_PLAN_APPROVAL_STATES)[number];

/**
 * Per-effect replay classification (spec §6.6).
 *
 *  - `idempotent`           — the write may be re-sent safely (group remove,
 *                             license remove, disable, revoke sessions).
 *  - `idempotent_by_probe`  — safe only because the pre-probe observes the end
 *                             state first (forwarding, auto-reply).
 *  - `non_idempotent`       — NEVER auto-retried (create user, reset password).
 *                             An unknown outcome hands the task off.
 */
export const AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES = Object.freeze([
  'idempotent', 'idempotent_by_probe', 'non_idempotent',
] as const);
export type AiOperatorEffectIdempotencyClass =
  (typeof AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES)[number];

/** One approved effect, as the approval card and the task page render it. */
export interface AiOperatorPlanEffectDto {
  ordinal: number;
  toolName: string;
  provider: 'breeze' | 'm365' | 'google';
  /** Frozen display label for the target, never re-resolved. */
  targetLabel: string;
  /** Frozen UPN / primary email at approval time, display only. Null for a
   *  `breeze` effect, which names a device row rather than a provider account. */
  principalLabel: string | null;
  /** Bounded human-readable rendering the approver actually signed off on. */
  rendering: string;
  idempotencyClass: AiOperatorEffectIdempotencyClass;
  /** Set once the effect has an operation; null while the plan is pending. */
  operationState: 'pending' | 'succeeded' | 'failed' | 'unknown' | 'superseded' | null;
  /** True when the pre-write probe already observed the end state (§6.6). */
  noop: boolean;
}

export interface AiOperatorPlanApprovalDto {
  id: string;
  taskId: string;
  planRevision: number;
  effectSetDigest: string;
  effectCount: number;
  intentId: string;
  state: AiOperatorPlanApprovalState;
  approvedByUserId: string | null;
  approvedAt: string | null;
  supersededByRevision: number | null;
  createdAt: string;
  effects: AiOperatorPlanEffectDto[];
}
```

- [ ] **Step 4: Run it green**

Run: `cd packages/shared && npx vitest run src/types/aiOperatorPlanApproval.test.ts`
Expected: PASS — 1 file, 3 tests.

- [ ] **Step 5: Commit**

```
git add packages/shared/src/types/aiOperator.ts packages/shared/src/types/aiOperatorPlanApproval.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): plan-approval state and effect-idempotency value lists (E4)

Recipe Library spec §5.4 and §6.6, as frozen runtime arrays plus the two
DTOs the approval card and task page render from. text+CHECK never pgEnum.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `effect_set_digest` — one canonicalizer, frozen vectors

**Files:**
- Create: `packages/shared/src/canonicalize/effectSet.ts`
- Create: `packages/shared/src/canonicalize/effectSet.test.ts`
- Modify: `packages/shared/src/canonicalize/vectors.ts` (append)
- Create: `packages/shared/src/canonicalize/effectSet.vectors.test.ts`

**Interfaces:**
- Consumes: `canonicalizeArguments`, `computeArgumentDigest` (`./index`).
- Produces:
  ```ts
  export const EFFECT_SET_DIGEST_ENVELOPE_VERSION = 1;
  export interface PlannedEffectForDigest {
    ordinal: number;
    toolName: string;
    provider: 'breeze' | 'm365' | 'google';
    targetId: string | null;
    accountExternalId: string | null;
    canonicalArguments: Readonly<Record<string, unknown>>;
  }
  export function canonicalizeEffectSet(args: {
    taskId: string; planRevision: number; effects: readonly PlannedEffectForDigest[];
  }): string;
  export function computeEffectSetDigest(args: {
    taskId: string; planRevision: number; effects: readonly PlannedEffectForDigest[];
  }): string;
  ```
  Plus in `vectors.ts`: `export const EFFECT_SET_VECTORS: readonly EffectSetVector[]` and `export interface EffectSetVector`.

**Why a wrapper and not a direct call:** `canonicalizeArguments(input: Record<string, unknown>)` (`packages/shared/src/canonicalize/index.ts:40`) takes an OBJECT, and an effect list is an ARRAY whose order is load-bearing (spec §6.3's safety ordering). The wrapper puts the ordered array inside a versioned envelope object so the one shipped canonicalizer — the same function `action_intents.argument_digest` uses — does the actual work, order is preserved (the canonicalizer sorts object keys and **never** reorders arrays, `index.ts:18-38`), and a future ordering or field change is a version bump rather than a silently different hash.

- [ ] **Step 1: Check the subpath export, then write the failing test**

Run: `grep -n '"./canonicalize' packages/shared/package.json`
If the exports map has a wildcard (`"./canonicalize/*"`), nothing to do. If it lists `"./canonicalize"` and `"./canonicalize/vectors"` individually, add `"./canonicalize/effectSet"` in the same shape beside them and say so in the commit message.

```ts
// packages/shared/src/canonicalize/effectSet.ts  ← test file below
// packages/shared/src/canonicalize/effectSet.test.ts
/**
 * Behaviour of the effect-set digest (Recipe Library spec §6.4:
 * "`effect_set_digest` = SHA-256 over the canonical serialization of that
 * list (same canonicalizer as `action_intents.arguments`)").
 *
 * The properties that matter are not "it hashes": they are that REORDERING
 * the list changes the digest (order is the §6.3 safety contract — disable
 * last), that key order inside one effect's arguments does NOT (a jsonb round
 * trip must not invalidate a live approval), and that the task id and plan
 * revision are inside the seal (otherwise the same effect list approved on one
 * task would validate on another).
 *
 * Frozen cross-implementation vectors live in `effectSet.vectors.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeEffectSet, computeEffectSetDigest, type PlannedEffectForDigest } from './effectSet';

const TASK = '00000000-0000-4000-8000-0000000000a1';

const suspend: PlannedEffectForDigest = {
  ordinal: 1, toolName: 'google_suspend_user', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1',
  accountExternalId: '101234567890',
  canonicalArguments: { userEmail: 'dana@customer.example', reason: 'offboarding' },
};
const removeGroup: PlannedEffectForDigest = {
  ordinal: 0, toolName: 'google_remove_from_group', provider: 'google',
  targetId: '00000000-0000-4000-8000-0000000000c1',
  accountExternalId: '101234567890',
  canonicalArguments: { userEmail: 'dana@customer.example', groupEmail: 'sales@customer.example', reason: 'offboarding' },
};

describe('computeEffectSetDigest', () => {
  it('is a 64-character lowercase hex SHA-256', () => {
    expect(computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [removeGroup, suspend] }))
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it('CHANGES when the effect ORDER changes — ordering is the §6.3 safety contract', () => {
    const forward = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [removeGroup, suspend] });
    const reversed = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend, removeGroup] });
    expect(reversed).not.toBe(forward);
  });

  it('does NOT change when argument KEY order changes — a jsonb round trip is not a plan change', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...suspend, canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' } }],
    });
    expect(b).toBe(a);
  });

  it('binds the TASK: the same list under another task digests differently', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: '00000000-0000-4000-8000-0000000000a2', planRevision: 1, effects: [suspend],
    });
    expect(b).not.toBe(a);
  });

  it('binds the PLAN REVISION: a superseded plan can never digest to the new one', () => {
    const r1 = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const r2 = computeEffectSetDigest({ taskId: TASK, planRevision: 2, effects: [suspend] });
    expect(r2).not.toBe(r1);
  });

  it('changes when a single argument VALUE changes', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...suspend, canonicalArguments: { ...suspend.canonicalArguments, userEmail: 'other@customer.example' } }],
    });
    expect(b).not.toBe(a);
  });

  it('changes when accountExternalId changes, even with identical arguments', () => {
    const a = computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [suspend] });
    const b = computeEffectSetDigest({
      taskId: TASK, planRevision: 1, effects: [{ ...suspend, accountExternalId: '999' }],
    });
    expect(b).not.toBe(a);
  });

  it('emits a versioned envelope whose effects array is in the caller-given order', () => {
    const canonical = canonicalizeEffectSet({ taskId: TASK, planRevision: 1, effects: [removeGroup, suspend] });
    expect(canonical).toContain('"v":1');
    expect(canonical.indexOf('google_remove_from_group')).toBeLessThan(canonical.indexOf('google_suspend_user'));
  });

  it('refuses an empty effect set — an approval over nothing is not an approval', () => {
    expect(() => computeEffectSetDigest({ taskId: TASK, planRevision: 1, effects: [] }))
      .toThrow(/at least one effect/);
  });

  it('refuses a set whose ordinals are not 0..n-1 in ascending order', () => {
    expect(() => computeEffectSetDigest({
      taskId: TASK, planRevision: 1,
      effects: [{ ...removeGroup, ordinal: 0 }, { ...suspend, ordinal: 5 }],
    })).toThrow(/contiguous/);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd packages/shared && npx vitest run src/canonicalize/effectSet.test.ts`
Expected: FAIL — cannot resolve `./effectSet`.

- [ ] **Step 3: Implement `packages/shared/src/canonicalize/effectSet.ts`**

```ts
/**
 * The effect-set digest (Recipe Library spec §6.4).
 *
 * ONE canonicalizer for the whole approval chain. This module does NOT hash
 * anything itself: it builds a versioned envelope and hands it to
 * `canonicalizeArguments` / `computeArgumentDigest` — the same two functions
 * `action_intents.argument_digest` is computed with
 * (`services/actionIntents/canonicalize.ts` re-exports them). A second hasher
 * here would turn every downstream digest comparison into a self-consistency
 * check, which is the exact failure `vectors.ts`'s header was written to
 * prevent.
 *
 * WHY AN ENVELOPE. `canonicalizeArguments` takes a `Record<string, unknown>`,
 * and the thing being sealed is an ORDERED ARRAY. The canonicalizer sorts
 * object keys and never reorders arrays, so wrapping the list in an object
 * preserves the §6.3 safety ordering (auto-reply first, disable/suspend last)
 * inside a structure the shipped function already handles.
 *
 * WHY taskId AND planRevision ARE INSIDE THE SEAL. Without them, an approver
 * who signed off on a nine-effect plan for Dana would have signed a digest
 * that also validates for an identical plan on a different task, or for the
 * same task after the plan was revised. The unit of pinning is the set ON THIS
 * TASK AT THIS REVISION.
 *
 * CHANGING THE ENVELOPE IS A BREAKING CHANGE. A stored `effect_set_digest`
 * was computed under these bytes; altering the shape invalidates every
 * approved-but-undispatched plan. Bump `EFFECT_SET_DIGEST_ENVELOPE_VERSION`
 * and add vectors, never edit the existing ones.
 */

import { canonicalizeArguments, computeArgumentDigest } from './index';

/** Envelope shape version. Inside the seal, so v1 and v2 can never collide. */
export const EFFECT_SET_DIGEST_ENVELOPE_VERSION = 1;

/**
 * The digestible projection of `PlannedEffect`
 * (`apps/api/src/services/aiOperator/recipes/types.ts`, wave E1).
 *
 * Restated here rather than imported because `@breeze/shared` may not import
 * `apps/api`. `planApproval.ts` maps one to the other in a single function, and
 * `planApproval.test.ts` pins that the field lists agree.
 */
export interface PlannedEffectForDigest {
  ordinal: number;
  toolName: string;
  provider: 'breeze' | 'm365' | 'google';
  targetId: string | null;
  accountExternalId: string | null;
  canonicalArguments: Readonly<Record<string, unknown>>;
}

export interface EffectSetDigestInput {
  taskId: string;
  planRevision: number;
  effects: readonly PlannedEffectForDigest[];
}

function assertWellFormed(effects: readonly PlannedEffectForDigest[]): void {
  if (effects.length === 0) {
    throw new Error('effect set must contain at least one effect');
  }
  // Ordinals are the membership key at release. A gap or a repeat would let two
  // different effects claim the same slot in the approved set, so this is a
  // structural refusal rather than a normalization.
  for (let i = 0; i < effects.length; i += 1) {
    if (effects[i]!.ordinal !== i) {
      throw new Error(
        `effect set ordinals must be contiguous and ascending from 0; index ${i} has ordinal ${effects[i]!.ordinal}`,
      );
    }
  }
}

export function canonicalizeEffectSet(input: EffectSetDigestInput): string {
  assertWellFormed(input.effects);
  return canonicalizeArguments({
    v: EFFECT_SET_DIGEST_ENVELOPE_VERSION,
    taskId: input.taskId,
    planRevision: input.planRevision,
    // Each effect is projected field-by-field rather than spread, so a field
    // added to `PlannedEffect` by a later wave cannot silently enter the seal
    // (which would invalidate every live approval on deploy) without an
    // envelope version bump and new vectors.
    effects: input.effects.map((e) => ({
      ordinal: e.ordinal,
      toolName: e.toolName,
      provider: e.provider,
      targetId: e.targetId,
      accountExternalId: e.accountExternalId,
      canonicalArguments: e.canonicalArguments,
    })),
  });
}

export function computeEffectSetDigest(input: EffectSetDigestInput): string {
  return computeArgumentDigest(canonicalizeEffectSet(input));
}
```

- [ ] **Step 4: Run it green**

Run: `cd packages/shared && npx vitest run src/canonicalize/effectSet.test.ts`
Expected: PASS — 1 file, 10 tests.

- [ ] **Step 5: Append the frozen vectors to `packages/shared/src/canonicalize/vectors.ts`**

Append at the very end of the file (after the closing `] as const;` of `CANONICALIZATION_VECTORS`):

```ts
/**
 * Frozen conformance vectors for the EFFECT-SET envelope (Recipe Library spec
 * §6.4), the second consumer of this canonicalizer.
 *
 * Same rule as the corpus above, and for the same reason: every `digest` was
 * computed once and pasted in. NEVER derive one at test time by calling
 * `computeEffectSetDigest` — a test that computes its own expectation passes
 * against any implementation, including a wrong one. CHANGING A DIGEST HERE IS
 * A BREAKING CHANGE: a stored `ai_operator_plan_approvals.effect_set_digest`
 * was computed under these bytes, and altering them invalidates every approved
 * plan that has not finished dispatching.
 */
export interface EffectSetVector {
  name: string;
  why: string;
  input: {
    taskId: string;
    planRevision: number;
    effects: readonly {
      ordinal: number;
      toolName: string;
      provider: 'breeze' | 'm365' | 'google';
      targetId: string | null;
      accountExternalId: string | null;
      canonicalArguments: Readonly<Record<string, unknown>>;
    }[];
  };
  /** Frozen canonical JSON of the envelope. */
  canonical: string;
  /** Frozen SHA-256 hex. Never recompute. */
  digest: string;
}

export const EFFECT_SET_VECTORS: readonly EffectSetVector[] = [
  {
    name: 'single-breeze-effect',
    why: 'The degenerate one-effect plan, and the only vector with a null accountExternalId — a device command names a target row, not a provider account (spec §6.4).',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 1,
      effects: [{
        ordinal: 0, toolName: 'manage_services', provider: 'breeze',
        targetId: '00000000-0000-4000-8000-0000000000d1',
        accountExternalId: null,
        canonicalArguments: { action: 'restart', deviceId: '00000000-0000-4000-8000-0000000000d1', serviceName: 'spooler' },
      }],
    },
    canonical: 'PASTE_FROM_STEP_6',
    digest: 'PASTE_FROM_STEP_6',
  },
  {
    name: 'two-provider-ordered-plan',
    why: 'Order is the §6.3 safety contract (mailbox effects while the account is live, suspend last). This vector and the next differ ONLY in order, so a hasher that sorted the array would produce one digest for both and fail here.',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 3,
      effects: [
        {
          ordinal: 0, toolName: 'google_set_forwarding', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          canonicalArguments: { forwardTo: 'manager@customer.example', keepCopy: true, reason: 'offboarding', userEmail: 'dana@customer.example' },
        },
        {
          ordinal: 1, toolName: 'google_suspend_user', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
        },
      ],
    },
    canonical: 'PASTE_FROM_STEP_6',
    digest: 'PASTE_FROM_STEP_6',
  },
  {
    name: 'two-provider-plan-reordered',
    why: 'Identical members to the previous vector, swapped. Pins that the two digests differ — the single property that makes "disable last" enforceable by a hash.',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 3,
      effects: [
        {
          ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
        },
        {
          ordinal: 1, toolName: 'google_set_forwarding', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          canonicalArguments: { forwardTo: 'manager@customer.example', keepCopy: true, reason: 'offboarding', userEmail: 'dana@customer.example' },
        },
      ],
    },
    canonical: 'PASTE_FROM_STEP_6',
    digest: 'PASTE_FROM_STEP_6',
  },
  {
    name: 'cross-provider-nine-effect-offboarding',
    why: 'The realistic shape §6.3 describes: both providers in one plan, so the corpus is not purely synthetic and a provider-field regression is caught.',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 2,
      effects: [
        { ordinal: 0, toolName: 'm365_set_auto_reply', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', canonicalArguments: { internalReplyMessage: 'Dana has left the company.', reason: 'offboarding', status: 'alwaysEnabled', userIdentifier: 'dana@customer.example' } },
        { ordinal: 1, toolName: 'google_set_vacation', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', canonicalArguments: { enable: true, message: 'Dana has left the company.', reason: 'offboarding', subject: 'No longer at the company', userEmail: 'dana@customer.example' } },
        { ordinal: 2, toolName: 'google_set_forwarding', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', canonicalArguments: { forwardTo: 'manager@customer.example', keepCopy: true, reason: 'offboarding', userEmail: 'dana@customer.example' } },
        { ordinal: 3, toolName: 'google_add_mail_delegate', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', canonicalArguments: { delegateEmail: 'manager@customer.example', reason: 'offboarding', userEmail: 'dana@customer.example' } },
        { ordinal: 4, toolName: 'm365_remove_from_group', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', canonicalArguments: { groupId: 'bbbbbbbb-2222-4000-8000-000000000002', reason: 'offboarding', userIdentifier: 'dana@customer.example' } },
        { ordinal: 5, toolName: 'm365_remove_license', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', canonicalArguments: { reason: 'offboarding', skuIds: ['cccccccc-3333-4000-8000-000000000003'], userIdentifier: 'dana@customer.example' } },
        { ordinal: 6, toolName: 'm365_retire_intune_device', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', canonicalArguments: { managedDeviceId: 'dddddddd-4444-4000-8000-000000000004', reason: 'offboarding' } },
        { ordinal: 7, toolName: 'm365_revoke_sessions', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', canonicalArguments: { reason: 'offboarding', userIdentifier: 'dana@customer.example' } },
        { ordinal: 8, toolName: 'google_suspend_user', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' } },
      ],
    },
    canonical: 'PASTE_FROM_STEP_6',
    digest: 'PASTE_FROM_STEP_6',
  },
] as const;
```

- [ ] **Step 6: Compute the four frozen digests ONCE and paste them in**

The placeholders above are the only `PASTE_FROM_STEP_6` strings in this plan; none may survive. Run, from the repo root:

```bash
cd packages/shared && npx tsx -e "
import { EFFECT_SET_VECTORS } from './src/canonicalize/vectors';
import { canonicalizeEffectSet, computeEffectSetDigest } from './src/canonicalize/effectSet';
for (const v of EFFECT_SET_VECTORS) {
  const canonical = canonicalizeEffectSet(v.input as any);
  console.log(JSON.stringify({ name: v.name, canonical, digest: computeEffectSetDigest(v.input as any) }, null, 2));
}
"
```

(If `tsx` is not on the path, use `npx vitest run src/canonicalize/effectSet.test.ts --reporter=verbose` after temporarily adding a `console.log` — but prefer `tsx`, and remove any temporary log before committing.)

Paste each printed `canonical` and `digest` into the matching vector. **Do not paste a value you did not see printed**, and never let the vectors test compute its own expectation.

- [ ] **Step 7: Write the conformance test**

```ts
// packages/shared/src/canonicalize/effectSet.vectors.test.ts
/**
 * Agreement, not behaviour. `effectSet.test.ts` next door covers behaviour;
 * this runs the FROZEN corpus so that if anything ever shadows, wraps or
 * re-implements the effect-set envelope, every stored
 * `ai_operator_plan_approvals.effect_set_digest` stops matching and this fails.
 *
 * Expectations are frozen constants and are NEVER recomputed — see the header
 * of `vectors.ts` for why that is the whole point.
 */
import { describe, expect, it } from 'vitest';
import { EFFECT_SET_VECTORS } from './vectors';
import { canonicalizeEffectSet, computeEffectSetDigest } from './effectSet';

describe('effect-set envelope conformance', () => {
  it('runs a non-empty corpus', () => {
    expect(EFFECT_SET_VECTORS.length).toBeGreaterThanOrEqual(4);
  });

  it('carries no unresolved placeholder', () => {
    for (const v of EFFECT_SET_VECTORS) {
      expect(v.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(v.canonical.startsWith('{')).toBe(true);
    }
  });

  it.each(EFFECT_SET_VECTORS.map((v) => [v.name, v] as const))(
    'vector %s produces the frozen canonical form and digest',
    (_name, vector) => {
      expect(canonicalizeEffectSet(vector.input)).toBe(vector.canonical);
      expect(computeEffectSetDigest(vector.input)).toBe(vector.digest);
    },
  );

  it('the two reorder vectors have different digests', () => {
    const a = EFFECT_SET_VECTORS.find((v) => v.name === 'two-provider-ordered-plan')!;
    const b = EFFECT_SET_VECTORS.find((v) => v.name === 'two-provider-plan-reordered')!;
    expect(b.digest).not.toBe(a.digest);
  });
});
```

- [ ] **Step 8: Run both green**

Run: `cd packages/shared && npx vitest run src/canonicalize/effectSet.test.ts src/canonicalize/effectSet.vectors.test.ts`
Expected: PASS — 2 files, 10 + 8 tests (4 parameterised cases).

Then confirm the pre-existing corpus is untouched:

Run: `cd packages/shared && npx vitest run src/canonicalize/canonicalize.test.ts && cd ../../apps/api && npx vitest run src/services/actionIntents/canonicalize.vectors.test.ts`
Expected: both PASS, and `git diff -- packages/shared/src/canonicalize/index.ts` is EMPTY. If `index.ts` had to change, the wrapper is wrong — fix the wrapper.

- [ ] **Step 9: Commit**

```
git add packages/shared/src/canonicalize/effectSet.ts packages/shared/src/canonicalize/effectSet.test.ts packages/shared/src/canonicalize/vectors.ts packages/shared/src/canonicalize/effectSet.vectors.test.ts packages/shared/package.json
git commit -m "$(cat <<'EOF'
feat(shared): effect_set_digest over the SAME canonicalizer action intents use (E4)

Recipe Library spec §6.4. A versioned envelope binds taskId + planRevision +
the ORDERED effect list, so a reordered plan (§6.3 safety contract) and a
plan from another task can never digest to an approved value. Frozen
vectors beside the existing corpus; index.ts is unmodified.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The two tables — migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-10-19-100000-ai-operator-plan-approvals.sql`
- Create: `apps/api/src/db/schema/aiOperatorPlanApprovals.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/aiOperator/enumParity.test.ts`

**Interfaces:**
- Consumes: `aiOperatorTasks` (`./aiOperatorTasks`), `organizations` (`./organizations`), `actionIntents` (`./actionIntents`), `users` (`./users`), `AI_OPERATOR_PLAN_APPROVAL_STATES`, `AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES` (`@breeze/shared`).
- Produces: `aiOperatorPlanApprovals`, `aiOperatorPlanApprovalEffects`, `AiOperatorPlanApprovalRow`, `AiOperatorPlanApprovalEffectRow`.

- [ ] **Step 1: Re-check the migration filename BEFORE writing anything**

Run: `ls apps/api/migrations/*.sql | sort | tail -3`
If anything sorts at or after `2026-10-19-100000`, pick a prefix that sorts strictly after the newest and use it everywhere below (filename, the `readFileSync` path in Task 13's suites, and the commit message). Shipped migration names run ahead of real time; today's date is **not** a safe prefix.

- [ ] **Step 2: Write the failing schema-shape test**

```ts
// apps/api/src/services/aiOperator/enumParity.test.ts  — APPEND these cases,
// do not rewrite the file.
/**
 * Plan-approval CHECK ↔ TypeScript parity (E4). The CHECK list in
 * 2026-10-19-100000-ai-operator-plan-approvals.sql, the Drizzle `as const`
 * array, and the @breeze/shared array must be the same three lists. They are
 * hand-written in three places because Operator spec §11.1 forbids pgEnum
 * under forced RLS (enum equality is not leakproof and cannot become an index
 * condition), so the only thing keeping them together is this test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES,
  AI_OPERATOR_PLAN_APPROVAL_STATES,
} from '@breeze/shared';
import {
  AI_OPERATOR_PLAN_APPROVAL_STATES as SCHEMA_PLAN_APPROVAL_STATES,
  AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES as SCHEMA_EFFECT_IDEMPOTENCY_CLASSES,
} from '../../db/schema/aiOperatorPlanApprovals';

const MIGRATION = readFileSync(
  join(__dirname, '../../../migrations/2026-10-19-100000-ai-operator-plan-approvals.sql'),
  'utf8',
);

function checkMembers(sql: string, column: string): string[] {
  const m = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql);
  if (!m) throw new Error(`no CHECK found for ${column} — the migration shape changed; fix this test`);
  return m[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('plan-approval enum parity (E4)', () => {
  it('state CHECK === schema array === shared array', () => {
    expect(checkMembers(MIGRATION, 'state')).toEqual([...AI_OPERATOR_PLAN_APPROVAL_STATES]);
    expect([...SCHEMA_PLAN_APPROVAL_STATES]).toEqual([...AI_OPERATOR_PLAN_APPROVAL_STATES]);
  });

  it('idempotency_class CHECK === schema array === shared array', () => {
    expect(checkMembers(MIGRATION, 'idempotency_class')).toEqual([...AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES]);
    expect([...SCHEMA_EFFECT_IDEMPOTENCY_CLASSES]).toEqual([...AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES]);
  });

  it('both tables FORCE row level security in the creating migration', () => {
    for (const t of ['ai_operator_plan_approvals', 'ai_operator_plan_approval_effects']) {
      expect(MIGRATION).toContain(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      for (const cmd of ['select', 'insert', 'update', 'delete']) {
        expect(MIGRATION).toContain(`breeze_org_isolation_${cmd}_${t}`);
      }
    }
  });

  it('every composite FK that references an org_id column is DEFERRABLE INITIALLY IMMEDIATE', () => {
    // Org merge runs SET CONSTRAINTS ALL DEFERRED and re-points parent and
    // child org_id in separate statements; a non-deferrable one aborts the
    // merge with 23503 (orgLifecycleFoundations.integration.test.ts).
    const fks = MIGRATION.match(/ADD CONSTRAINT[\s\S]*?FOREIGN KEY[\s\S]*?(?=;)/g) ?? [];
    expect(fks.length).toBeGreaterThanOrEqual(4);
    for (const fk of fks) {
      if (/org_id/.test(fk)) expect(fk).toMatch(/DEFERRABLE INITIALLY IMMEDIATE/);
    }
  });

  it('the migration writes no rows, so it needs no breeze.scope election', () => {
    expect(MIGRATION).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/im);
  });
});
```

- [ ] **Step 3: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/enumParity.test.ts`
Expected: FAIL — the migration file does not exist (`ENOENT`).

- [ ] **Step 4: Write the migration**

```sql
-- apps/api/migrations/2026-10-19-100000-ai-operator-plan-approvals.sql
--
-- Operator Recipe Library wave E4 — plan approval (spec §5.4, §6.4).
--
-- WHAT THIS IS. One four-eyes decision over an ORDERED, DIGEST-PINNED SET of
-- provider effects. Nine offboarding effects across two providers would
-- otherwise be up to eighteen separate four-eyes approvals; nobody would use
-- that, and a feature nobody uses is not a safety control.
--
-- THREE THINGS THAT ARE DELIBERATE AND MUST NOT BE "SIMPLIFIED":
--
--  A. The effect SET is CHILD ROWS, not jsonb. Membership is checked at
--     RELEASE, from these rows, against the same rows the approver's card was
--     rendered from. A jsonb blob would also be forced to `excludedOpen` in
--     CORE_TENANT_EXPORT_POLICY (every jsonb column is), which would drop the
--     record of what was done to a person out of a GDPR tenant export.
--
--  B. `effect_set_digest` is a SECOND, independent seal over those same rows,
--     computed by the SAME canonicalizer action_intents.argument_digest uses
--     (@breeze/shared/canonicalize). It is not the membership check; it is what
--     makes a row mutated under a live approval detectable.
--
--  C. UNIQUE (org_id, task_id, plan_revision) is what makes supersession
--     total: a new plan needs a new revision, and a new revision cannot reuse
--     an approved row.
--
-- NO ROWS ARE WRITTEN BY THIS FILE, so it elects no breeze.scope and stays out
-- of migrationRlsScope.test.ts's frozen baseline. Never add a new file there.
--
-- Idempotent throughout. No inner BEGIN/COMMIT — autoMigrate wraps each file
-- in one transaction.

CREATE TABLE IF NOT EXISTS ai_operator_plan_approvals (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id),
  task_id                uuid NOT NULL,

  -- = ai_operator_tasks.revision at the moment the plan was proposed. The
  -- release-time membership check requires the task's CURRENT revision to
  -- still equal this: a revision bump IS the supersession.
  plan_revision          integer NOT NULL,

  -- SHA-256 over the canonical ordered effect list (spec §6.4).
  effect_set_digest      char(64) NOT NULL,

  -- Denormalized count. Not a convenience: the membership check asserts it
  -- equals the number of child rows, so a partially-deleted set is detectable
  -- rather than silently narrowing what was approved.
  effect_count           integer NOT NULL,

  -- The single action intent carrying the approval (tool name `operator_plan`).
  intent_id              uuid NOT NULL,

  state                  text NOT NULL DEFAULT 'pending',

  -- Written when the plan intent is released. Every child effect is attributed
  -- to this user and, per D-E4-2, EXECUTES under their live authority.
  approved_by_user_id    uuid,
  approved_at            timestamptz,
  -- The assurance level the approver presented (mirrors
  -- action_intents.decided_assurance_level). Carried so a child effect's audit
  -- row can state it without re-reading the intent.
  approved_assurance_level smallint,

  -- The task's revision at the moment this plan was superseded. Null while
  -- live. Recorded rather than inferred: "superseded" without "by what" is
  -- unanswerable a month later, which is exactly when it is asked.
  superseded_by_revision integer,

  -- Digest of the admitting agent's policy snapshot at proposal time
  -- (computePolicySnapshotDigest). The ceiling check compares against this, so
  -- a policy edit after approval is detectable at release.
  policy_snapshot_digest text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_operator_plan_approvals_state_chk
    CHECK (state IN ('pending','approved','rejected','expired','superseded')),
  CONSTRAINT ai_operator_plan_approvals_effect_count_chk
    CHECK (effect_count > 0 AND effect_count <= 64),
  CONSTRAINT ai_operator_plan_approvals_revision_chk
    CHECK (plan_revision >= 0),
  CONSTRAINT ai_operator_plan_approvals_digest_chk
    CHECK (effect_set_digest ~ '^[0-9a-f]{64}$'),
  -- An `approved` row without an approver is the shape a bypass would take.
  CONSTRAINT ai_operator_plan_approvals_approved_chk
    CHECK (state <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT ai_operator_plan_approvals_superseded_chk
    CHECK (state <> 'superseded' OR superseded_by_revision IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ai_operator_plan_approval_effects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  approval_id          uuid NOT NULL,
  task_id              uuid NOT NULL,
  plan_revision        integer NOT NULL,

  ordinal              integer NOT NULL,
  tool_name            text NOT NULL,
  provider             text NOT NULL,
  -- ai_operator_task_targets.id (E2). A typed reference, no hard FK: the
  -- target row carries ON DELETE SET NULL semantics of its own and an
  -- append-only approved-set row must not be rewritten by a target delete.
  target_id            uuid,
  -- Entra object id / Google user id. Immutable, never the UPN — a rename
  -- mid-task cannot retarget an approved effect (spec §5.2, D2).
  account_external_id  text,
  -- SHA-256 of the effect's canonicalized arguments, computed by the SAME
  -- function action_intents.argument_digest is. This column, with (task_id,
  -- plan_revision, ordinal), IS the membership key checked at release.
  argument_digest      char(64) NOT NULL,

  -- Frozen display labels. Rendered on the approval card and never
  -- re-resolved: what the approver read is what is stored.
  target_label         text NOT NULL,
  principal_label      text,
  rendering            text NOT NULL,

  idempotency_class    text NOT NULL,

  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_operator_plan_approval_effects_provider_chk
    CHECK (provider IN ('breeze','m365','google')),
  CONSTRAINT ai_operator_plan_approval_effects_idempotency_class_chk
    CHECK (idempotency_class IN ('idempotent','idempotent_by_probe','non_idempotent')),
  CONSTRAINT ai_operator_plan_approval_effects_ordinal_chk
    CHECK (ordinal >= 0 AND ordinal < 64),
  CONSTRAINT ai_operator_plan_approval_effects_digest_chk
    CHECK (argument_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_operator_plan_approval_effects_tool_name_len_chk
    CHECK (char_length(tool_name) BETWEEN 1 AND 128),
  CONSTRAINT ai_operator_plan_approval_effects_rendering_len_chk
    CHECK (char_length(rendering) BETWEEN 1 AND 500),
  CONSTRAINT ai_operator_plan_approval_effects_target_label_len_chk
    CHECK (char_length(target_label) BETWEEN 1 AND 200),
  CONSTRAINT ai_operator_plan_approval_effects_principal_label_len_chk
    CHECK (principal_label IS NULL OR char_length(principal_label) BETWEEN 1 AND 320),
  -- A breeze effect names a device row, not a provider account (spec §6.4).
  CONSTRAINT ai_operator_plan_approval_effects_account_chk
    CHECK (provider <> 'breeze' OR account_external_id IS NULL)
);

-- ── uniqueness ──────────────────────────────────────────────────────────────

-- One live plan per (task, revision). This is what makes supersession total.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approvals_task_revision_uq
  ON ai_operator_plan_approvals (org_id, task_id, plan_revision);

-- The tuple children reference, so an effect row can never name an approval of
-- a different task or a different org.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approvals_id_task_org_uq
  ON ai_operator_plan_approvals (id, task_id, org_id);

-- One intent carries one plan, and one plan is carried by one intent.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approvals_intent_uq
  ON ai_operator_plan_approvals (org_id, intent_id);

-- THE membership index. The release check reads exactly this tuple.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approval_effects_membership_uq
  ON ai_operator_plan_approval_effects (org_id, task_id, plan_revision, ordinal);

CREATE INDEX IF NOT EXISTS ai_operator_plan_approval_effects_approval_idx
  ON ai_operator_plan_approval_effects (approval_id, ordinal);

CREATE INDEX IF NOT EXISTS ai_operator_plan_approvals_task_state_idx
  ON ai_operator_plan_approvals (org_id, task_id, state);

-- ── foreign keys ────────────────────────────────────────────────────────────
-- Every composite FK naming an org_id column is DEFERRABLE INITIALLY IMMEDIATE:
-- org merge runs SET CONSTRAINTS ALL DEFERRED and re-points parent and child
-- org_id in separate statements (orgLifecycleFoundations.integration.test.ts,
-- "merge contract"). A non-deferrable one aborts the merge with 23503.

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approvals
    ADD CONSTRAINT ai_operator_plan_approvals_task_org_fk
    FOREIGN KEY (task_id, org_id)
    REFERENCES ai_operator_tasks (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approvals
    ADD CONSTRAINT ai_operator_plan_approvals_intent_org_fk
    FOREIGN KEY (intent_id, org_id)
    REFERENCES action_intents (id, org_id)
    -- RESTRICT, not CASCADE: action_intents are never hard-deleted, and an
    -- approval whose intent vanished must be visible as a broken row rather
    -- than disappear along with the evidence of who approved what.
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approvals
    ADD CONSTRAINT ai_operator_plan_approvals_approver_fk
    FOREIGN KEY (approved_by_user_id)
    REFERENCES users (id)
    -- Plain FK, SET NULL: users are org-movable and the approver is
    -- attribution, not tenancy. approved_at survives, so "approved, by a user
    -- since deleted" stays readable.
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approval_effects
    ADD CONSTRAINT ai_operator_plan_approval_effects_approval_task_org_fk
    FOREIGN KEY (approval_id, task_id, org_id)
    REFERENCES ai_operator_plan_approvals (id, task_id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── RLS: Shape 1, ENABLE + FORCE, four policies, in the creating migration ──

ALTER TABLE ai_operator_plan_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_plan_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_plan_approval_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_plan_approval_effects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_select_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_insert_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_update_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_delete_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_select_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_insert_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_update_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_delete_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── immutability: an approved effect row is EVIDENCE ────────────────────────
-- The set an approver signed is not editable. UPDATE is revoked outright and a
-- trigger backs it up, because the whole primitive rests on "the rows at
-- release are the rows on the card". DELETE is left to the app (and to the
-- cascade) so a superseded plan's rows can be reaped with the approval, but an
-- in-place edit is unreachable.

REVOKE UPDATE ON ai_operator_plan_approval_effects FROM breeze_app;

CREATE OR REPLACE FUNCTION ai_operator_plan_approval_effects_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ai_operator_plan_approval_effects rows are immutable: an approved effect set is the evidence of what a human authorized (Recipe Library spec §6.4). Supersede the plan and write a new revision.'
    USING ERRCODE = 'raise_exception';
END $$;

DROP TRIGGER IF EXISTS ai_operator_plan_approval_effects_no_update ON ai_operator_plan_approval_effects;
CREATE TRIGGER ai_operator_plan_approval_effects_no_update
  BEFORE UPDATE ON ai_operator_plan_approval_effects
  FOR EACH ROW EXECUTE FUNCTION ai_operator_plan_approval_effects_block_update();
```

- [ ] **Step 5: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/aiOperatorPlanApprovals.ts
/**
 * Plan approval (Recipe Library spec §5.4, §6.4), wave E4.
 *
 * Mirrors 2026-10-19-100000-ai-operator-plan-approvals.sql. Every value list
 * below is `text` + CHECK, never pgEnum (Operator spec §11.1: under forced RLS
 * enum equality is not leakproof and cannot become an index condition), and
 * the three copies — CHECK, this array, @breeze/shared — are pinned together
 * by `services/aiOperator/enumParity.test.ts`.
 */
import { sql } from 'drizzle-orm';
import {
  char, foreignKey, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';
import { actionIntents } from './actionIntents';
import { aiOperatorTasks } from './aiOperatorTasks';

export const AI_OPERATOR_PLAN_APPROVAL_STATES = [
  'pending', 'approved', 'rejected', 'expired', 'superseded',
] as const;
export type AiOperatorPlanApprovalState = (typeof AI_OPERATOR_PLAN_APPROVAL_STATES)[number];

export const AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES = [
  'idempotent', 'idempotent_by_probe', 'non_idempotent',
] as const;
export type AiOperatorEffectIdempotencyClass =
  (typeof AI_OPERATOR_EFFECT_IDEMPOTENCY_CLASSES)[number];

export const AI_OPERATOR_EFFECT_PROVIDERS = ['breeze', 'm365', 'google'] as const;
export type AiOperatorEffectProvider = (typeof AI_OPERATOR_EFFECT_PROVIDERS)[number];

export const aiOperatorPlanApprovals = pgTable(
  'ai_operator_plan_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    taskId: uuid('task_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    effectSetDigest: char('effect_set_digest', { length: 64 }).notNull(),
    effectCount: integer('effect_count').notNull(),
    intentId: uuid('intent_id').notNull(),
    state: text('state').$type<AiOperatorPlanApprovalState>().notNull().default('pending'),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedAssuranceLevel: smallint('approved_assurance_level'),
    supersededByRevision: integer('superseded_by_revision'),
    policySnapshotDigest: text('policy_snapshot_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    taskRevisionUq: uniqueIndex('ai_operator_plan_approvals_task_revision_uq')
      .on(table.orgId, table.taskId, table.planRevision),
    idTaskOrgUq: uniqueIndex('ai_operator_plan_approvals_id_task_org_uq')
      .on(table.id, table.taskId, table.orgId),
    intentUq: uniqueIndex('ai_operator_plan_approvals_intent_uq').on(table.orgId, table.intentId),
    taskStateIdx: index('ai_operator_plan_approvals_task_state_idx')
      .on(table.orgId, table.taskId, table.state),
    taskOrgFk: foreignKey({
      columns: [table.taskId, table.orgId],
      foreignColumns: [aiOperatorTasks.id, aiOperatorTasks.orgId],
      name: 'ai_operator_plan_approvals_task_org_fk',
    }).onDelete('cascade'),
    intentOrgFk: foreignKey({
      columns: [table.intentId, table.orgId],
      foreignColumns: [actionIntents.id, actionIntents.orgId],
      name: 'ai_operator_plan_approvals_intent_org_fk',
    }).onDelete('restrict'),
  }),
);

export const aiOperatorPlanApprovalEffects = pgTable(
  'ai_operator_plan_approval_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    approvalId: uuid('approval_id').notNull(),
    taskId: uuid('task_id').notNull(),
    planRevision: integer('plan_revision').notNull(),
    ordinal: integer('ordinal').notNull(),
    toolName: text('tool_name').notNull(),
    provider: text('provider').$type<AiOperatorEffectProvider>().notNull(),
    /** `ai_operator_task_targets.id` (E2). Typed reference, NO hard FK — an
     *  append-only evidence row must not be rewritten by a target delete. */
    targetId: uuid('target_id'),
    accountExternalId: text('account_external_id'),
    argumentDigest: char('argument_digest', { length: 64 }).notNull(),
    targetLabel: text('target_label').notNull(),
    principalLabel: text('principal_label'),
    rendering: text('rendering').notNull(),
    idempotencyClass: text('idempotency_class')
      .$type<AiOperatorEffectIdempotencyClass>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    membershipUq: uniqueIndex('ai_operator_plan_approval_effects_membership_uq')
      .on(table.orgId, table.taskId, table.planRevision, table.ordinal),
    approvalIdx: index('ai_operator_plan_approval_effects_approval_idx')
      .on(table.approvalId, table.ordinal),
    approvalTaskOrgFk: foreignKey({
      columns: [table.approvalId, table.taskId, table.orgId],
      foreignColumns: [
        aiOperatorPlanApprovals.id, aiOperatorPlanApprovals.taskId, aiOperatorPlanApprovals.orgId,
      ],
      name: 'ai_operator_plan_approval_effects_approval_task_org_fk',
    }).onDelete('cascade'),
  }),
);

export type AiOperatorPlanApprovalRow = typeof aiOperatorPlanApprovals.$inferSelect;
export type AiOperatorPlanApprovalEffectRow = typeof aiOperatorPlanApprovalEffects.$inferSelect;

/** Silences the unused-import lint on `sql` if no partial index needs it; if
 *  the executor adds one, delete this line. */
void sql;
```

Then export it from the barrel. Run `grep -n "aiOperatorTaskGraph" apps/api/src/db/schema/index.ts` and add, on the line AFTER that export:

```ts
export * from './aiOperatorPlanApprovals';
```

- [ ] **Step 6: Run the parity test green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/enumParity.test.ts`
Expected: PASS — the pre-existing cases plus 5 new ones.

- [ ] **Step 7: Apply the migration against a live stack and verify RLS as `breeze_app`**

```bash
pnpm test-stack up          # repo root; writes .env.test
cd apps/api && npx tsx -e "import('./src/db/autoMigrate').then(m => m.runMigrations())"
```

Then forge a cross-tenant insert — it must be REFUSED, not merely filtered:

```bash
docker exec -it $(docker ps --format '{{.Names}}' | grep -m1 postgres) \
  psql -U breeze_app -d breeze -c "
    SELECT set_config('breeze.scope','org',false), set_config('breeze.org_id','00000000-0000-0000-0000-000000000001',false);
    INSERT INTO ai_operator_plan_approvals (org_id, task_id, plan_revision, effect_set_digest, effect_count, intent_id)
    VALUES ('00000000-0000-0000-0000-000000000002', gen_random_uuid(), 1, repeat('a',64), 1, gen_random_uuid());"
```
Expected: `ERROR: new row violates row-level security policy for table "ai_operator_plan_approvals"`.

Leave the stack up for Tasks 13 and 17; `pnpm test-stack down` at the end of Task 17.

- [ ] **Step 8: Commit**

```
git add apps/api/migrations/2026-10-19-100000-ai-operator-plan-approvals.sql apps/api/src/db/schema/aiOperatorPlanApprovals.ts apps/api/src/db/schema/index.ts apps/api/src/services/aiOperator/enumParity.test.ts
git commit -m "$(cat <<'EOF'
feat(api): ai_operator_plan_approvals + _effects, Shape 1, forced RLS (E4)

Recipe Library spec §5.4. The approved effect SET is child rows, not jsonb:
membership is checked at release FROM THESE ROWS, and a jsonb column would
be excludedOpen in the tenant export. Effect rows are immutable (REVOKE
UPDATE + trigger) because the set an approver signed is evidence.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Cascade, export-policy and org-merge registration

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/services/orgMergeRegistry.ts`

**This is a mechanical grep, not a judgement call.** Missing a list is a latent GDPR org-erasure bug; it has shipped or blocked CI five times (#1359, #1351, #1365, #2179, #2514) and code review caught it 0/5 while the contract tests caught it 5/5.

- [ ] **Step 1: Prove the gap first — run the contract suites RED**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`
Expected: FAIL, naming `ai_operator_plan_approvals` and `ai_operator_plan_approval_effects` as `org_id` tables missing from the lists. **Record the exact failure text in the commit message** — it is the proof this task was needed.

- [ ] **Step 2: `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`)**

Alphabetical by `localeCompare`, `organizations` last, **FK children before parents**. `ai_operator_plan_approval_effects` references `ai_operator_plan_approvals`, and alphabetically `…_effects` sorts AFTER `…_approvals` — so alphabetical order would delete the parent first. It does not break: the child FK is `ON DELETE CASCADE`, so the parent delete removes the children and the later child delete is a no-op. **Verify this, do not assume it** (`tenantCascade.integration.test.ts` asserts FK children before parents as one of its five properties); if the assertion fails, the correct fix is to place `ai_operator_plan_approval_effects` immediately before `ai_operator_plan_approvals` with a comment saying alphabetical order is deliberately broken by an FK edge, which the test's own exemption mechanism supports.

Insert both entries in `localeCompare` position — run `grep -n "'ai_operator" apps/api/src/services/tenantCascade.ts` and place them beside the existing `ai_operator_*` entries:

```ts
  'ai_operator_plan_approval_effects',
  'ai_operator_plan_approvals',
```

Neither goes in `AUDIT_ADMIN_REQUIRED_TABLES`: `ai_operator_plan_approval_effects` revokes UPDATE but **not** DELETE, precisely so org erasure can reap it without an admin connection.

- [ ] **Step 3: `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`)**

Every column of every org-cascade table must be classified. Neither table has a `json`/`jsonb`/`bytea` column, so nothing is `excludedOpen` — that is why the set was modelled as rows (D-E4-3). `effect_set_digest`, `argument_digest` and `policy_snapshot_digest` match `SUSPICIOUS_NAME_PARTS` ("digest") and therefore go in `reviewedIncluded` with a written reason, never `included`.

```ts
  ai_operator_plan_approvals: tablePolicy('org_id', {
    included: [
      'id', 'task_id', 'plan_revision', 'effect_count', 'intent_id', 'state',
      'approved_by_user_id', 'approved_at', 'approved_assurance_level',
      'superseded_by_revision', 'created_at', 'updated_at',
    ],
    reviewedIncluded: [
      // Name matches SUSPICIOUS_NAME_PARTS ("digest"), reviewed non-secret:
      // a SHA-256 over an effect list the approver was SHOWN in full. It
      // reveals nothing the same tenant's export does not already contain,
      // and it is the only thing that lets an auditor prove the exported
      // effect rows are the ones that were approved.
      'effect_set_digest',
      // Digest of the agent's policy snapshot, not the snapshot. Same
      // argument; the snapshot itself is exported with ai_agent_runs.
      'policy_snapshot_digest',
    ],
  }),
  ai_operator_plan_approval_effects: tablePolicy('org_id', {
    included: [
      'id', 'approval_id', 'task_id', 'plan_revision', 'ordinal', 'tool_name',
      'provider', 'target_id', 'account_external_id', 'target_label',
      'principal_label', 'rendering', 'idempotency_class', 'created_at',
    ],
    reviewedIncluded: [
      // As above: a hash of arguments the approver read on the card. Excluding
      // it would make the export unable to answer "was THIS effect the one
      // that was approved", which is the question an erasure audit asks.
      'argument_digest',
    ],
  }),
```

- [ ] **Step 4: `orgMergeRegistry.ts`**

Run `grep -n "ai_operator" apps/api/src/services/orgMergeRegistry.ts` and add both tables beside the existing `ai_operator_*` dispositions, matching whatever disposition `ai_operator_operations` carries — a plan approval is task-child history with the same lifetime and the same reason not to be re-stamped (`ai_operator_tasks.org_id` is immutable history; re-stamping a child would break `ai_operator_plan_approvals_task_org_fk`). Use the same comment shape as the neighbouring entries and name this plan.

If the registry's classification requires a BEFORE trigger declaration (the seventh registration list — `orgMergeRegistry.integration.test.ts`'s `ORG_ID_BLOCKING_TRIGGERS`), neither table has one: the only trigger added by Task 3 is a `BEFORE UPDATE` immutability guard on the effects table, and **that guard WILL block an org-merge `UPDATE`**. Register it in `ORG_ID_BLOCKING_TRIGGERS` (`src/__tests__/integration/orgMergeRegistry.integration.test.ts:187`) with the rationale *"effect rows are immutable evidence; the merge must reach them through the task's own cascade/detach path, never by re-stamping org_id"*. **Run the merge contract before assuming this is correct** (Step 5).

- [ ] **Step 5: Run the four contract suites green**

Run:
```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: 4 files, all PASS. `rls-coverage` must pass with **no allowlist entry** for either table — both are Shape 1 and auto-discovered. If it asks for an allowlist entry, the migration's RLS block is wrong; fix the migration (it is unshipped and therefore still editable), not the test.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts
git commit -m "$(cat <<'EOF'
chore(api): register the two plan-approval tables in every cascade list (E4)

Org cascade, tenant export policy (every column classified; the three
*_digest columns are reviewedIncluded with a written reason), org-merge
disposition, and the effects table's immutability trigger in
ORG_ID_BLOCKING_TRIGGERS. Contract suites were red before this commit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Register `operator_plan` everywhere a real tool is registered

**Files:**
- Create: `apps/api/src/services/aiToolsAiOperator.ts`
- Create: `apps/api/src/services/aiToolsAiOperator.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` (call the registrar)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS`)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TIER3_FOUR_EYES_TOOLS`, `TOOL_PERMISSIONS`, `AGENT_HUMAN_ONLY_TOOLS`, `buildApprovalDescription`)
- Modify: `apps/api/src/services/aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY`) and its snapshot
- Modify: `apps/api/src/services/actionIntents/effectDigest.ts` (`EFFECT_DIGEST_RESOLVERS`)
- Modify: `apps/web/src/components/ai-risk/tierConfig.ts`

**The registration set was established by `grep -rn 'm365_disable_user' --include='*.ts' --include='*.tsx' .` and by reading each contract test's assertion.** These are the six contracts that go red if a step is skipped — the plan lists them so a red is diagnosable rather than mysterious:

| Contract test | Goes red if you skip |
|---|---|
| `aiAgentSdkTools.registryParity.contract.test.ts` | the registry entry, or a `TOOL_TIERS` tier that disagrees with it |
| `aiGuardrails.approvalScope.contract.test.ts` | the `TIER3_FOUR_EYES_TOOLS` entry (a tier-3 tool in **neither** whole-tool scope set fails `expect(inFourEyes !== inSupervised).toBe(true)`) |
| `agentToolCatalog.contract.test.ts` | the `TOOL_CAPABILITY` entry (`Object.keys(TOOL_CAPABILITY)` must equal `[...aiTools.keys()]` **exactly**), and its `listUnreachableRegisteredTools()` snapshot |
| `effectDigestCoverage.contract.test.ts` | the `EFFECT_DIGEST_RESOLVERS` entry (every four-eyes surface needs one or a written exemption — D-E4-4 chooses the resolver) |
| `aiToolPermissionsCatalogParity.contract.test.ts` (#6110) | a `TOOL_PERMISSIONS` pair naming a resource/action that is not in the canonical catalog |
| `aiGuardrailsTierConfig.parity.test.ts` | the `tierConfig.ts` Tier-3 row the web risk dashboard renders |

**Interfaces:**
- Produces: `registerAiOperatorTools()`, `operatorPlanHandler(input, auth)`.

- [ ] **Step 1: Write the failing registration test**

```ts
// apps/api/src/services/aiToolsAiOperator.test.ts
/**
 * `operator_plan` is a tool that EXECUTES NOTHING (Recipe Library spec §6.4:
 * "One action intent is minted with tool name `operator_plan` … On approval,
 * each effect's operation is dispatched under the plan approval").
 *
 * It is registered as a real tool anyway, and that is the point: registration
 * is what makes it tier 3, four-eyes, RBAC-gated, effect-digest-pinned, and
 * renderable on the existing approval card and mobile takeover — six shipped
 * controls it would otherwise have to reimplement. Its handler's whole job is
 * to mark the plan approved and wake the task.
 *
 * It is in AGENT_HUMAN_ONLY_TOOLS so a MODEL can never propose one. That is
 * safe for our own mint path: `createActionIntent` classifies through
 * `resolveGuardrailForIntent` -> `checkGuardrails` (intentService.ts:1086-1097),
 * never `checkAgentGuardrails`, and the plan intent is minted under a HUMAN
 * principal (the task's requester) in any case — see the plan's D-E4-2.
 */
import { describe, expect, it, vi } from 'vitest';
import { aiTools } from './aiToolNames';
import './aiTools';
import { getToolTier } from './aiTools';
import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  AGENT_HUMAN_ONLY_TOOLS, TIER3_FOUR_EYES_TOOLS, TIER3_SUPERVISED_TOOLS,
  TOOL_PERMISSIONS, checkGuardrails, resolveApprovalScope,
} from './aiGuardrails';
import { TOOL_CAPABILITY, listAgentReachableTools } from './aiAgents/agentToolCatalog';
import { effectDigestResolverKey } from './actionIntents/effectDigest';

describe('operator_plan registration', () => {
  it('is a registered core tool at tier 3, and TOOL_TIERS agrees', () => {
    expect(aiTools.has('operator_plan')).toBe(true);
    expect(getToolTier('operator_plan')).toBe(3);
    expect(TOOL_TIERS.operator_plan).toBe(3);
  });

  it('is FOUR-EYES, and is in exactly one whole-tool scope set', () => {
    expect(TIER3_FOUR_EYES_TOOLS.has('operator_plan')).toBe(true);
    expect(TIER3_SUPERVISED_TOOLS.has('operator_plan')).toBe(false);
    expect(resolveApprovalScope('operator_plan', undefined, {})).toBe('four_eyes');
  });

  it('checkGuardrails resolves it to tier 3 four_eyes end to end, not by table lookup alone', () => {
    const check = checkGuardrails('operator_plan', {
      taskId: '00000000-0000-4000-8000-0000000000a1', planRevision: 1,
      effectSetDigest: 'a'.repeat(64), effects: [],
    });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('four_eyes');
    expect(check.readOnly).not.toBe(true);
  });

  it('carries an RBAC requirement', () => {
    expect(TOOL_PERMISSIONS.operator_plan).toBeDefined();
  });

  it('is HUMAN-ONLY: no agent may ever propose a plan approval', () => {
    expect(AGENT_HUMAN_ONLY_TOOLS.has('operator_plan')).toBe(true);
    expect(listAgentReachableTools()).not.toContain('operator_plan');
  });

  it('maps to a capability, so the catalog parity contract holds', () => {
    expect(TOOL_CAPABILITY.operator_plan).toBeDefined();
  });

  it('PINS its effect content with a real resolver, not a DELIBERATELY_UNPINNED exemption', () => {
    // Unlike every m365_/google_ four-eyes surface (whose target lives in
    // someone else\'s system), everything operator_plan references is a local
    // row — so it can and must be pinned. See the plan\'s D-E4-4.
    expect(effectDigestResolverKey('operator_plan')).toBe('operator_plan');
  });

  it('the handler dispatches NOTHING: it marks the plan approved and wakes the task', async () => {
    const markPlanApproved = vi.fn().mockResolvedValue({ ok: true, taskId: 't1', planRevision: 2 });
    vi.doMock('./aiOperator/planApproval', () => ({ markPlanApproved }));
    const { operatorPlanHandler } = await import('./aiToolsAiOperator');
    const out = await operatorPlanHandler(
      { taskId: 't1', planRevision: 2, effectSetDigest: 'a'.repeat(64) },
      { orgId: 'o1', userId: 'u1' } as never,
    );
    expect(markPlanApproved).toHaveBeenCalledTimes(1);
    expect(out).toContain('approved');
    vi.doUnmock('./aiOperator/planApproval');
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiToolsAiOperator.test.ts`
Expected: FAIL — `aiTools.has('operator_plan')` is `false` and the module does not exist.

- [ ] **Step 3: Create `apps/api/src/services/aiToolsAiOperator.ts`**

```ts
/**
 * The AI Operator's own tool surface. Today it holds exactly one entry.
 *
 * `operator_plan` is the carrier for a plan approval (Recipe Library spec
 * §6.4). It performs no external effect: releasing it marks
 * `ai_operator_plan_approvals.state = 'approved'`, stamps the approver, and
 * wakes the task, which then dispatches each approved effect as its own child
 * intent. It is registered as a REAL tool because registration is what buys
 * tier 3, the four-eyes classification, the RBAC gate, the effect-digest pin,
 * the approval card, the mobile takeover and the durable release worker —
 * every one of which this primitive would otherwise have to reimplement, and
 * a reimplementation is where a four-eyes bypass would hide (spec §11).
 */
import { registerTool } from './aiToolNames';
import type { AuthContext } from '../middleware/auth';
import { markPlanApproved } from './aiOperator/planApproval';

/**
 * Immutable arguments of a plan intent (spec §6.4). Deliberately SMALL and
 * deliberately NOT the effect rows themselves: the rows are the authority
 * (D-E4-3) and these arguments are the seal plus what the approver reads.
 * `effects` is a bounded rendering — at most 64 lines of at most 500 chars,
 * mirroring the CHECK constraints on `ai_operator_plan_approval_effects`.
 */
export interface OperatorPlanArguments {
  taskId: string;
  planRevision: number;
  effectSetDigest: string;
  /** One frozen human-readable line per effect, in dispatch order. */
  effects?: string[];
  reason?: string;
}

export async function operatorPlanHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
): Promise<string> {
  const taskId = typeof input.taskId === 'string' ? input.taskId : null;
  const planRevision = typeof input.planRevision === 'number' ? input.planRevision : null;
  const effectSetDigest = typeof input.effectSetDigest === 'string' ? input.effectSetDigest : null;
  if (!taskId || planRevision === null || !effectSetDigest) {
    return JSON.stringify({ error: 'operator_plan requires taskId, planRevision and effectSetDigest' });
  }

  // The handler re-verifies the digest against the ROWS. It is reached only
  // through the release worker, which has already revalidated the intent and
  // (via the effect-digest resolver) re-hashed those same rows — so this is
  // defense in depth, not the check. It exists because a handler that trusted
  // its own arguments would be the one place in the chain where "the approver
  // saw these effects" is asserted rather than proven.
  const result = await markPlanApproved({
    orgId: auth.orgId!,
    taskId,
    planRevision,
    expectedEffectSetDigest: effectSetDigest,
    approverUserId: auth.userId!,
  });
  if (!result.ok) return JSON.stringify({ error: result.reason });

  return `Plan revision ${planRevision} approved for task ${taskId}; `
    + `${result.effectCount} effect(s) will be dispatched in order.`;
}

export function registerAiOperatorTools(): void {
  registerTool({
    name: 'operator_plan',
    tier: 3,
    handler: operatorPlanHandler,
  });
}
```

> **Executor note:** `registerTool` / `aiToolNames` is the shape used by the other `aiTools*.ts` modules. Run `grep -n "registerTool\|export function register" apps/api/src/services/aiToolsAlerts.ts` and copy that file's exact registration call shape — including whether it takes a description and a zod schema. Do **not** guess the signature.

Then call it. Run `grep -n "registerAiTools\|register.*Tools()" apps/api/src/services/aiTools.ts | head -20` and add `registerAiOperatorTools();` beside the sibling calls, alphabetically.

- [ ] **Step 4: The six registry edits**

1. **`aiAgentSdkTools.ts`** — add to `TOOL_TIERS` (the object literal starting at `:163`), beside the other non-domain entries:
   ```ts
   // AI Operator plan approval (Recipe Library spec §6.4). Never declared as
   // a chat `tool(...)`, so the model cannot call it; the tier exists because
   // every intent classification path reads TOOL_TIERS.
   operator_plan: 3,
   ```
2. **`aiGuardrails.ts` → `TIER3_FOUR_EYES_TOOLS`** (`:389`), immediately after the M365 block at `:403-406`:
   ```ts
   // AI Operator plan approval — ONE four-eyes decision over an ordered,
   // digest-pinned set of provider effects (Recipe Library spec §6.4). It is
   // four_eyes for the same reason every effect inside it is: the set can
   // destroy a person's access across two providers.
   'operator_plan',
   ```
3. **`aiGuardrails.ts` → `TOOL_PERMISSIONS`** (`:702`), beside the `m365_disable_user` entry at `:1197`:
   ```ts
   // Org-wide identity governance, provider-neutral: a plan may contain M365
   // effects, Google effects and device commands at once, so it takes the
   // ceiling of the families rather than any one provider's resource.
   operator_plan: { resource: 'organizations', action: 'write' },
   ```
   **Verify the pair exists in the canonical permission catalog** by running `cd apps/api && npx vitest run src/services/aiToolPermissionsCatalogParity.contract.test.ts` (added by PR #6110; if that file is absent, #6110 has not merged — grep the catalog directly with `grep -rn "'organizations'" apps/api/src/services/permissions*`). If `organizations:write` is not a catalog entry, pick the nearest one that is and say so in the commit message.
4. **`aiGuardrails.ts` → `AGENT_HUMAN_ONLY_TOOLS`** (`:450`):
   ```ts
   // Recipe Library spec §6.2: "The model never proposes an effect that
   // buildPlan did not produce, never edits plan arguments, and never marks
   // anything done." A model that could raise an operator_plan intent could
   // author the set a human then approves in one click — which is the
   // four-eyes bypass §11 names. The COORDINATOR raises it, under the task's
   // human requester (plan D-E4-2).
   'operator_plan',
   ```
5. **`aiGuardrails.ts` → `buildApprovalDescription`** (the `switch (toolName)` at `:2367`) — add a case so the card headline is not the generic `titleCaseWords` fallback:
   ```ts
   case 'operator_plan': {
     const n = Array.isArray(input.effects) ? input.effects.length : 0;
     return `Approve an ${n}-effect plan for AI Operator task ${String(input.taskId ?? '')}`;
   }
   ```
6. **`aiAgents/agentToolCatalog.ts` → `TOOL_CAPABILITY`** — map it to whichever capability id the other governance tools use (`grep -n "manage_ai_agents:" apps/api/src/services/aiAgents/agentToolCatalog.ts` and reuse that id). Then refresh the `listUnreachableRegisteredTools()` snapshot: run `cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.contract.test.ts -u` and **read the snapshot diff** — the only change may be `operator_plan` appearing in the unreachable list. Any other movement means an unrelated registry change slipped in; stop and report.
7. **`apps/web/src/components/ai-risk/tierConfig.ts`** — add a Tier 3 `ToolEntry` with `name` exactly `operator_plan` under the category the parity test expects (`grep -n "m365_disable_user" apps/web/src/components/ai-risk/tierConfig.ts` and copy the neighbouring row's shape).

- [ ] **Step 5: The effect-digest resolver (`services/actionIntents/effectDigest.ts`)**

Add to `EFFECT_DIGEST_RESOLVERS` (the object at `:158`). Follow the shape of the existing resolvers exactly: take `(args, database)`, return `material(...)` / `MISSING_ARG` / `TARGET_ABSENT`, never throw.

```ts
  // operator_plan (Tier 3, FOUR_EYES) — Recipe Library spec §6.4.
  //
  // Unlike every m365_/google_ four-eyes surface, which is DELIBERATELY_UNPINNED
  // because its target lives in Microsoft's or Google's system, everything this
  // tool references is a LOCAL row. The approval's whole authority is "these
  // rows are the effects a human read on the card", so the release path must be
  // able to prove the rows have not moved. This resolver re-reads them and
  // returns the canonical ordered list; `computeEffectDigestForRelease`
  // compares against the digest stored at creation and the release fails
  // `digest_mismatch` before `revalidatePlanApprovalMembership` even runs.
  //
  // Two independent seals over one set, which is the right posture for the
  // primitive that grants four-eyes authority to a SET rather than to a call.
  operator_plan: async (args, database) => {
    const taskId = typeof args.taskId === 'string' ? args.taskId : null;
    const planRevision = typeof args.planRevision === 'number' ? args.planRevision : null;
    if (!taskId || planRevision === null) return MISSING_ARG;

    const rows = await database
      .select({
        ordinal: aiOperatorPlanApprovalEffects.ordinal,
        toolName: aiOperatorPlanApprovalEffects.toolName,
        provider: aiOperatorPlanApprovalEffects.provider,
        targetId: aiOperatorPlanApprovalEffects.targetId,
        accountExternalId: aiOperatorPlanApprovalEffects.accountExternalId,
        argumentDigest: aiOperatorPlanApprovalEffects.argumentDigest,
      })
      .from(aiOperatorPlanApprovalEffects)
      .where(and(
        eq(aiOperatorPlanApprovalEffects.taskId, taskId),
        eq(aiOperatorPlanApprovalEffects.planRevision, planRevision),
      ))
      .orderBy(asc(aiOperatorPlanApprovalEffects.ordinal));

    // No rows = the plan was superseded and reaped, or never written. Both are
    // `target_absent`, which stores a NULL digest at CREATION. At RELEASE the
    // membership check refuses independently (`plan_approval_missing`), so a
    // null digest here is never the only thing standing in the way.
    if (rows.length === 0) return TARGET_ABSENT;

    // `v: 1` envelope, matching packages/shared/src/canonicalize/effectSet.ts.
    // Deliberately NOT a call to computeEffectSetDigest: this module hashes the
    // MATERIAL it returns (resolveEffectDigest does the sha256), so returning a
    // digest here would double-hash and never compare equal.
    return material(JSON.stringify({
      v: 1,
      taskId,
      planRevision,
      effects: rows.map((r) => ({
        ordinal: r.ordinal, toolName: r.toolName, provider: r.provider,
        targetId: r.targetId, accountExternalId: r.accountExternalId,
        argumentDigest: r.argumentDigest,
      })),
    }));
  },
```

Add the import at the top of `effectDigest.ts`: `import { aiOperatorPlanApprovalEffects } from '../../db/schema/aiOperatorPlanApprovals';` and `asc` to the existing `drizzle-orm` import.

> **The creation side must use the same material.** Task 6's `proposePlanApproval` writes the effect rows and mints the intent in an order that lets `createActionIntent` compute this digest over rows that already exist — see Task 6 Step 3's ordering note. If the rows do not exist yet at mint time, the stored digest is NULL and the pin silently does nothing; Task 13's membership suite asserts a non-null `action_intents.effect_digest` on a live plan intent for exactly this reason.

- [ ] **Step 6: Run green**

Run:
```
cd apps/api && npx vitest run \
  src/services/aiToolsAiOperator.test.ts \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/actionIntents/effectDigestCoverage.contract.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts
```
Expected: 6 files, all PASS. `cd apps/web && npx vitest run src/components/ai-risk` must also pass.

- [ ] **Step 7: Commit**

```
git add apps/api/src/services/aiToolsAiOperator.ts apps/api/src/services/aiToolsAiOperator.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiAgents/__snapshots__ apps/api/src/services/actionIntents/effectDigest.ts apps/web/src/components/ai-risk/tierConfig.ts
git commit -m "$(cat <<'EOF'
feat(api): register operator_plan as a tier-3 four-eyes tool that executes nothing (E4)

Recipe Library spec §6.4. Registration buys the tier, the four-eyes
classification, RBAC, the approval card, mobile, and the durable release
worker. AGENT_HUMAN_ONLY_TOOLS keeps the model from ever proposing one.
Unlike every other four-eyes surface it gets a REAL effect-digest resolver:
everything it references is a local row, so the release path can prove the
approved effect rows have not moved.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `planApproval.ts` — propose, approve, supersede, and the ONE membership predicate

**Files:**
- Create: `apps/api/src/services/aiOperator/planApproval.ts`
- Create: `apps/api/src/services/aiOperator/planApproval.test.ts`

**This file is the whole primitive.** Every other task either feeds it or consumes its one predicate. It lives in its own module — not in `taskCoordinator.ts` — for two reasons: W03 is editing the coordinator in parallel (D-E4-8), and a security predicate that must be read in one sitting should not be page 14 of a 1,034-line file.

**Interfaces:**
- Consumes: `db`, `runOutsideDbContext`, `withSystemDbAccessContext` (`../../db`); `aiOperatorPlanApprovals`, `aiOperatorPlanApprovalEffects` (`../../db/schema/aiOperatorPlanApprovals`); `aiOperatorTasks` (`../../db/schema/aiOperatorTasks`); `computeEffectSetDigest`, `type PlannedEffectForDigest` (`@breeze/shared/canonicalize/effectSet`); `canonicalizeArguments`, `computeArgumentDigest` (`../actionIntents/canonicalize`); `createActionIntent` (`../actionIntents/intentService`); `buildAuthContextForUser` (`../actionIntents/actorContext` — see Step 3's note); `appendTaskEvent` (`./eventService`, E2); `isSecretBearingTool` (`../actionIntents/secretBearingTools`); `type PlannedEffect` (`./recipes/types`, E1).
- Produces:
  ```ts
  export type PlanDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;
  export interface PlanSplit { planned: PlannedEffect[]; individual: PlannedEffect[] }
  export function splitSecretBearingEffects(effects: readonly PlannedEffect[]): PlanSplit;
  export function toDigestProjection(effects: readonly PlannedEffect[]): PlannedEffectForDigest[];
  export function effectArgumentDigest(effect: PlannedEffect): string;

  export interface ProposePlanApprovalInput {
    orgId: string; taskId: string; planRevision: number;
    requesterUserId: string | null;
    effects: readonly PlannedEffect[];
    labels: ReadonlyMap<number, { targetLabel: string; principalLabel: string | null; rendering: string }>;
    idempotencyClasses: ReadonlyMap<string, AiOperatorEffectIdempotencyClass>;
    policySnapshotDigest: string | null;
  }
  export type ProposePlanApprovalResult =
    | { ok: true; approvalId: string; intentId: string; effectSetDigest: string; effectCount: number }
    | { ok: false; reason: 'no_requester' | 'empty_plan' | 'secret_bearing_effect' | 'revision_moved' | 'already_proposed' };
  export async function proposePlanApproval(input: ProposePlanApprovalInput): Promise<ProposePlanApprovalResult>;

  export type MarkPlanApprovedResult =
    | { ok: true; taskId: string; planRevision: number; effectCount: number }
    | { ok: false; reason: 'plan_approval_missing' | 'not_pending' | 'digest_mismatch' | 'revision_moved' };
  export async function markPlanApproved(args: {
    orgId: string; taskId: string; planRevision: number;
    expectedEffectSetDigest: string; approverUserId: string; approverAssuranceLevel?: number | null;
  }): Promise<MarkPlanApprovedResult>;

  export async function bumpPlanRevision(dbh: PlanDbHandle, args: {
    orgId: string; taskId: string; fromRevision: number; leaseEpoch: number; detail: string;
  }): Promise<{ bumped: boolean; newRevision: number; supersededApprovalId: string | null; cancelledIntentIds: string[] }>;

  export type PlanMembershipRefusal =
    | 'plan_approval_missing' | 'plan_not_approved' | 'plan_superseded' | 'plan_expired'
    | 'revision_moved' | 'effect_not_in_set' | 'argument_digest_mismatch'
    | 'tool_not_in_set' | 'effect_count_mismatch';
  export type PlanMembershipResult =
    | { ok: true; approvalId: string; approverUserId: string; idempotencyClass: AiOperatorEffectIdempotencyClass }
    | { ok: false; refusal: PlanMembershipRefusal; detail: string };
  export async function checkPlanEffectMembership(dbh: PlanDbHandle, args: {
    orgId: string; taskId: string; planRevision: number; ordinal: number;
    toolName: string; argumentDigest: string;
  }): Promise<PlanMembershipResult>;
  ```

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/api/src/services/aiOperator/planApproval.test.ts
/**
 * The plan-approval primitive (Recipe Library spec §6.4).
 *
 * These are the PURE halves plus the membership predicate against a stubbed
 * handle. The row-level, cross-tenant and replay properties are proved against
 * real Postgres in
 * `src/__tests__/integration/aiOperatorPlanApprovalMembership.integration.test.ts`
 * — a stub cannot prove RLS, a unique index, or a deferrable FK, and this file
 * does not pretend to.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkPlanEffectMembership, effectArgumentDigest, splitSecretBearingEffects, toDigestProjection,
} from './planApproval';
import type { PlannedEffect } from './recipes/types';

const suspend: PlannedEffect = {
  ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
  targetId: 'c1', accountExternalId: '101',
  canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
};
const createUser: PlannedEffect = {
  ordinal: 1, toolName: 'm365_reset_password', provider: 'm365',
  targetId: 'c1', accountExternalId: 'aaa',
  canonicalArguments: { reason: 'onboarding', userIdentifier: 'dana@customer.example' },
};

/** Minimal chainable stub: `select().from().where().limit()` resolves to rows. */
function handleReturning(...resultSets: unknown[][]) {
  let call = 0;
  const chain = () => {
    const rows = resultSets[Math.min(call, resultSets.length - 1)] ?? [];
    const p: Record<string, unknown> = {};
    for (const k of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
      p[k] = () => Object.assign(Promise.resolve(rows), p);
    }
    return Object.assign(Promise.resolve(rows), p);
  };
  return {
    select: () => { call += 1; return chain(); },
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  } as never;
}

describe('splitSecretBearingEffects (spec §6.4: secret-bearing effects are EXCLUDED from plan approval)', () => {
  it('routes a secret-bearing effect to its own individual intent and keeps the rest in the plan', () => {
    const split = splitSecretBearingEffects([suspend, createUser]);
    expect(split.planned.map((e) => e.toolName)).toEqual(['google_suspend_user']);
    expect(split.individual.map((e) => e.toolName)).toEqual(['m365_reset_password']);
  });

  it('RE-ORDINALS the planned effects contiguously from 0 — the ordinal is the membership key', () => {
    // A gap would make the effect-set digest throw and, worse, would leave an
    // ordinal slot no effect claims. The excluded effect keeps its ORIGINAL
    // ordinal on `individual` so the dispatch order of the whole recipe (spec
    // §6.3) is still recoverable.
    const split = splitSecretBearingEffects([createUser, suspend]);
    expect(split.planned.map((e) => e.ordinal)).toEqual([0]);
    expect(split.individual[0]!.ordinal).toBe(1);
  });

  it('a plan of nothing but secret-bearing effects yields an EMPTY planned set', () => {
    expect(splitSecretBearingEffects([createUser]).planned).toEqual([]);
  });
});

describe('effectArgumentDigest', () => {
  it('is the SAME digest action_intents.argument_digest will carry for that effect', () => {
    // The membership key at release is (task, revision, ordinal, argument_digest),
    // and the release side reads the digest off the INTENT. If these two were
    // computed differently, every dispatch would be refused — or, far worse,
    // a change of canonicalizer on one side only would let a mutated argument
    // match a stale row.
    const { canonicalizeArguments, computeArgumentDigest } =
      require('../actionIntents/canonicalize') as typeof import('../actionIntents/canonicalize');
    expect(effectArgumentDigest(suspend))
      .toBe(computeArgumentDigest(canonicalizeArguments(suspend.canonicalArguments as Record<string, unknown>)));
  });

  it('ignores argument key order', () => {
    expect(effectArgumentDigest({
      ...suspend, canonicalArguments: { userEmail: 'dana@customer.example', reason: 'offboarding' },
    })).toBe(effectArgumentDigest(suspend));
  });
});

describe('toDigestProjection', () => {
  it('projects exactly the six sealed fields, in effect order', () => {
    expect(toDigestProjection([suspend])).toEqual([{
      ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
      targetId: 'c1', accountExternalId: '101',
      canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
    }]);
  });
});

describe('checkPlanEffectMembership — the ONE predicate the release path calls', () => {
  const base = {
    orgId: 'o1', taskId: 't1', planRevision: 2, ordinal: 0,
    toolName: 'google_suspend_user', argumentDigest: 'd'.repeat(64),
  };
  const approvedPlan = {
    id: 'p1', state: 'approved', planRevision: 2, effectCount: 1,
    approvedByUserId: 'u-approver', taskRevision: 2,
  };
  const matchingEffect = {
    ordinal: 0, toolName: 'google_suspend_user', argumentDigest: 'd'.repeat(64),
    idempotencyClass: 'idempotent',
  };

  it('admits an effect that is in the approved set at the task\'s current revision', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([approvedPlan], [matchingEffect], [{ n: 1 }]), base,
    );
    expect(res).toMatchObject({ ok: true, approvalId: 'p1', approverUserId: 'u-approver' });
  });

  it('REFUSES when there is no approval row at all', async () => {
    const res = await checkPlanEffectMembership(handleReturning([]), base);
    expect(res).toMatchObject({ ok: false, refusal: 'plan_approval_missing' });
  });

  it('REFUSES a plan that is still pending — approval is a state, not the row\'s existence', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([{ ...approvedPlan, state: 'pending' }]), base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'plan_not_approved' });
  });

  it('REFUSES a superseded plan', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([{ ...approvedPlan, state: 'superseded' }]), base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'plan_superseded' });
  });

  it('REFUSES an expired plan', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([{ ...approvedPlan, state: 'expired' }]), base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'plan_expired' });
  });

  it('REFUSES when the TASK has moved on, even though the approval still reads approved', async () => {
    // This is the supersede race: the approval row is updated in the same
    // transaction as the revision bump, but a reader that only checked the
    // row's state would admit an effect in the window before that commit is
    // visible. The task's revision is the authority.
    const res = await checkPlanEffectMembership(
      handleReturning([{ ...approvedPlan, taskRevision: 3 }]), base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'revision_moved' });
  });

  it('REFUSES an ordinal that is not in the set', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([approvedPlan], []), { ...base, ordinal: 7 },
    );
    expect(res).toMatchObject({ ok: false, refusal: 'effect_not_in_set' });
  });

  it('REFUSES the SAME ordinal with a DIFFERENT argument digest — the core §7.1 property', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([approvedPlan], [{ ...matchingEffect, argumentDigest: 'e'.repeat(64) }]),
      base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'argument_digest_mismatch' });
  });

  it('REFUSES the same ordinal and digest under a DIFFERENT tool name', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([approvedPlan], [{ ...matchingEffect, toolName: 'google_signout' }]),
      base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'tool_not_in_set' });
  });

  it('REFUSES when the child row count no longer matches effect_count', async () => {
    // A partially deleted set would otherwise NARROW what was approved
    // silently, which is the direction that looks safe and is not: the
    // approver signed an ORDER, and a missing earlier effect changes what a
    // later one means (spec §6.3 — suspend last).
    const res = await checkPlanEffectMembership(
      handleReturning([approvedPlan], [matchingEffect], [{ n: 0 }]), base,
    );
    expect(res).toMatchObject({ ok: false, refusal: 'effect_count_mismatch' });
  });

  it('returns the effect\'s idempotency class, which the dispatcher needs before any retry', async () => {
    const res = await checkPlanEffectMembership(
      handleReturning([approvedPlan], [{ ...matchingEffect, idempotencyClass: 'non_idempotent' }], [{ n: 1 }]),
      base,
    );
    expect(res).toMatchObject({ ok: true, idempotencyClass: 'non_idempotent' });
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/planApproval.test.ts`
Expected: FAIL — cannot resolve `./planApproval`.

- [ ] **Step 3: Implement `apps/api/src/services/aiOperator/planApproval.ts`**

Write the module with these bodies. Four things the executor must get exactly right, each called out at its site:

**(i) Ordering inside `proposePlanApproval`.** Three writes in this order, because each depends on the previous one existing:
1. **One transaction**: insert the `ai_operator_plan_approvals` row with `state = 'pending'` and a **placeholder `intent_id`**? — No. `intent_id` is `NOT NULL` and there is no placeholder. Instead: insert the **effect rows first**, keyed on `(org_id, task_id, plan_revision, ordinal)` with no `approval_id` yet — also impossible, `approval_id` is `NOT NULL`.
   The workable order is therefore: **mint the intent first, then insert approval + effects in one transaction.** `createActionIntent` computes the effect digest at creation via `computeEffectDigestOutcome`, which reads rows that do not exist yet and stores `NULL` — so the pin would be dead on arrival.
   **Resolution, and it is the one the executor must implement:** call `createActionIntent` with `guardrailContext` unchanged but **defer the pin**: after the approval and effect rows commit, call `computeEffectDigestForRelease('operator_plan', intentArgs, db)` and write the resulting digest onto `action_intents.effect_digest` via a single narrow UPDATE **inside the same transaction as the row inserts**, guarded on `effect_digest IS NULL AND status = 'pending_approval'`. Two facts make this safe rather than a hole: `action_intents` content columns are immutable by trigger but `effect_digest` is a lifecycle column written by the creation path (`intentService.ts` stamps it at insert), and the guard means the digest can be written exactly once, before any approver can have seen the card. **Step 3a below makes the executor verify the immutability trigger's deny-list before writing this** — if `effect_digest` is in it, the fallback is to build the effect rows in memory, compute the digest from them with `computeEffectSetDigest`, pass it as an argument, and let the resolver compare against rows on release (the resolver already returns row-derived material, so the comparison still catches row drift; only the "computed from rows at creation" property is lost, and the plan's `effect_set_digest` column already carries it).
2. Append an `appendTaskEvent` row (`eventType: 'plan_proposed'`, actor `{ kind: 'coordinator' }`) in the same transaction.

**(ii) `markPlanApproved` is a CAS, not a read-then-write.** One `UPDATE … SET state='approved', approved_by_user_id=…, approved_at=now() WHERE org_id=? AND task_id=? AND plan_revision=? AND state='pending' AND effect_set_digest=? RETURNING effect_count`, joined against the task's current `revision`. Zero rows updated is a refusal, never a retry. The caller is the release worker, which is already single-flighted by `transitionIntent`'s `approved → executing` CAS, so a lost race here means someone else already approved this exact plan and the second caller must not "fix" it.

**(iii) `bumpPlanRevision` does three writes in ONE transaction**, and the order matters because a reader between them must never see an approved plan at a revision the task has left:
```
UPDATE ai_operator_tasks SET revision = revision + 1 WHERE id=? AND org_id=? AND revision=? AND lease_epoch=? RETURNING revision
UPDATE ai_operator_plan_approvals SET state='superseded', superseded_by_revision=<new> WHERE org_id=? AND task_id=? AND plan_revision=<from> AND state IN ('pending','approved') RETURNING id, intent_id
UPDATE action_intents SET status='cancelled', error_code='plan_superseded' WHERE org_id=? AND task_id=? AND status IN ('pending_approval','approved') AND id IN (<the plan intent> ∪ <child intents whose operation is still 'reserved'>) RETURNING id
```
The third statement **must not** touch an intent whose operation is already `dispatched` or `executing`: a dispatched effect is a real-world change, and cancelling its intent would destroy the record of it without undoing it. Filter on `ai_operator_operations.dispatch_state = 'reserved'` via an `EXISTS`, and say so in a comment. Then `appendTaskEvent({ eventType: 'plan_superseded', … })`.

> **Naming note for the executor:** `taskCoordinator.ts:302-345`'s `admitReasoningRun` already has a **boolean parameter** called `bumpPlanRevision`. That is a different thing and it keeps its name. This exported function is `bumpPlanRevision(dbh, args)` in `planApproval.ts`; the coordinator reaches it through the Task 12 wiring, and Task 12 does not rename the boolean.

**(iv) `checkPlanEffectMembership` reads THREE things and refuses in a fixed order.** Approval row joined to the task's live `revision`; then the effect row at that exact `(task, revision, ordinal)`; then a `count(*)` of the set. The refusal order is: missing → not approved (with `superseded`/`expired` reported distinctly, because the UI copy differs) → revision moved → effect absent → tool mismatch → digest mismatch → count mismatch. It performs **no writes** and takes a caller-supplied `PlanDbHandle` so it joins the caller's transaction — the release path calls it inside the same transaction that will CAS the intent.

Additional required bodies:

```ts
/**
 * Spec §6.4: "Secret-bearing effects (onboarding's temporary password) are
 * excluded from plan approval and keep their individual intent."
 *
 * A credential is not something a technician can meaningfully pre-approve in a
 * list of nine lines: the whole control around `SECRET_BEARING_TOOLS` is the
 * seal/reveal path on ONE intent's `result`, and a plan approval has no result
 * to seal into. The planned set is re-ordinalled contiguously from 0 because
 * the ordinal IS the membership key; the excluded effects keep their original
 * ordinals so the recipe's §6.3 dispatch order is still recoverable.
 */
export function splitSecretBearingEffects(effects: readonly PlannedEffect[]): PlanSplit {
  const individual = effects.filter((e) => isSecretBearingTool(e.toolName));
  const planned = effects
    .filter((e) => !isSecretBearingTool(e.toolName))
    .map((e, i) => ({ ...e, ordinal: i }));
  return { planned, individual };
}

/**
 * The per-effect digest. MUST be the same value
 * `action_intents.argument_digest` will carry for that effect, because the
 * release-time membership key is (task, revision, ordinal, argument_digest)
 * and the release side reads the digest off the intent, not off the effect.
 * Hence `../actionIntents/canonicalize`, never a local hash.
 */
export function effectArgumentDigest(effect: PlannedEffect): string {
  return computeArgumentDigest(
    canonicalizeArguments(effect.canonicalArguments as Record<string, unknown>),
  );
}
```

- [ ] **Step 3a: Verify the `effect_digest` immutability deny-list BEFORE implementing (i)**

Run: `grep -rn "action_intents_block_content_update" apps/api/migrations/*.sql | head` then read the newest definition and check whether `effect_digest` is among the columns it refuses to let change. Record the answer in the commit message and implement whichever of the two branches of (i) it permits. **Do not edit the trigger** — it is shipped.

- [ ] **Step 4: Run it green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/planApproval.test.ts`
Expected: PASS — 1 file, 17 tests.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/planApproval.ts apps/api/src/services/aiOperator/planApproval.test.ts
git commit -m "$(cat <<'EOF'
feat(api): the plan-approval primitive — propose, approve, supersede, membership (E4)

Recipe Library spec §6.4. checkPlanEffectMembership is the ONE predicate the
release path calls; it reads ROWS, joins the task's live revision, and
refuses in a fixed order. Secret-bearing effects are split out and keep
their individual intent. bumpPlanRevision cancels only UNDISPATCHED child
intents — a dispatched effect is a real-world change and its record stays.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `createActionIntent` — the allowlist ceiling and the `planApproval` branch

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts`
- Modify: `apps/api/src/services/actionIntents/intentService.test.ts` (append; do not rewrite)

**Interfaces:**
- Produces: `CreateActionIntentInput.planApproval?: { approvalId: string; ordinal: number }`; new `ActionIntentError` codes `tool_not_in_agent_allowlist`, `plan_approval_invalid`.

- [ ] **Step 1: Read the two insertion points and the attribution CHECKs**

```bash
grep -n "site ceiling\|allowedSiteIds\|orgWideGovernance" apps/api/src/services/actionIntents/intentService.ts | head
grep -n "task context is only valid for the ai_agent principal" apps/api/src/services/actionIntents/intentService.ts
grep -rn "action_intents.*CHECK" apps/api/migrations/*action-intents*.sql | head -20
```
If PR #6110 has merged, the first grep finds its site-ceiling block — the allowlist check goes **immediately below it, in the same block**. If it has not, put the allowlist check where the site check will go and leave `// #6110 adds the SITE ceiling here; this is the ALLOWLIST ceiling (spec §6.4).`

- [ ] **Step 2: Write the failing tests** (append to `intentService.test.ts`)

```ts
/**
 * E4 — the two new gates on createActionIntent.
 *
 * (1) THE ALLOWLIST CEILING. Recipe Library spec §6.4's closing line: "a plan
 *     intent cannot name a tool the admitting agent's snapshot does not
 *     allow". Without it, a plan is a way to get a set of tools approved that
 *     the agent was never granted — a four-eyes bypass by composition, which
 *     is exactly the risk §11 names. The ceiling is checked at MINT and again
 *     at RELEASE (revalidateRelease.ts, Task 8): a policy edited in between
 *     must revoke, and a check in only one place cannot do that.
 *
 * (2) THE planApproval BRANCH. See the plan's D-E4-2 for why a human-shaped
 *     intent may carry task context when — and only when — a row-backed plan
 *     membership proof accompanies it.
 */
describe('createActionIntent: agent tool-allowlist ceiling (E4)', () => {
  it('REFUSES a plan intent naming a tool outside the admitting agent\'s frozen allowlist', async () => {
    // toolAllowlist = ['google_suspend_user']; the plan names google_signout.
    await expect(createActionIntent(planAuth, {
      toolName: 'google_signout', source: 'mcp_api',
      input: { userEmail: 'dana@customer.example', reason: 'offboarding' },
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    })).rejects.toMatchObject({ code: 'tool_not_in_agent_allowlist' });
  });

  it('ADMITS a tool that IS in the allowlist', async () => {
    await expect(createActionIntent(planAuth, {
      toolName: 'google_suspend_user', source: 'mcp_api',
      input: { userEmail: 'dana@customer.example', reason: 'offboarding' },
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    })).resolves.toMatchObject({ actionName: 'google_suspend_user' });
  });

  it('the ceiling reads the TASK\'s frozen snapshot, not the agent\'s live policy', async () => {
    // A policy WIDENED after admission must not retroactively authorize an
    // effect the approver's plan was built under. Operator spec P3-4 freezes
    // the recipe version for the same reason.
    widenLiveAgentPolicy(['google_suspend_user', 'google_signout']);
    await expect(createActionIntent(planAuth, {
      toolName: 'google_signout', source: 'mcp_api',
      input: { userEmail: 'dana@customer.example', reason: 'offboarding' },
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    })).rejects.toMatchObject({ code: 'tool_not_in_agent_allowlist' });
  });
});

describe('createActionIntent: the planApproval branch (E4)', () => {
  it('still REFUSES task context from a human principal with NO planApproval', async () => {
    await expect(createActionIntent(humanAuth, {
      toolName: 'google_suspend_user', source: 'mcp_api', input: {}, task: TASK_CTX,
    })).rejects.toMatchObject({ code: 'task_context_not_allowed' });
  });

  it('REFUSES planApproval without task context — the two are one proof', async () => {
    await expect(createActionIntent(planAuth, {
      toolName: 'google_suspend_user', source: 'mcp_api', input: {},
      planApproval: { approvalId: 'p1', ordinal: 0 },
    })).rejects.toMatchObject({ code: 'plan_approval_invalid' });
  });

  it('REFUSES when membership does not hold, propagating the refusal reason', async () => {
    stubMembership({ ok: false, refusal: 'plan_superseded', detail: 'superseded by revision 3' });
    await expect(createActionIntent(planAuth, {
      toolName: 'google_suspend_user', source: 'mcp_api', input: {},
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    })).rejects.toMatchObject({ code: 'plan_approval_invalid' });
  });

  it('stamps the intent APPROVED, decided_via plan_approval, decided BY the plan\'s approver', async () => {
    const snap = await createActionIntent(planAuth, {
      toolName: 'google_suspend_user', source: 'mcp_api',
      input: { userEmail: 'dana@customer.example', reason: 'offboarding' },
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    });
    expect(snap.status).toBe('approved');
    const row = await readIntentRow(snap.id);
    expect(row.decidedVia).toBe('plan_approval');
    expect(row.decidedByUserId).toBe('u-approver');
    expect(row.requestingAgentRunId).toBeNull();
    expect(row.releaseBy).not.toBeNull();
  });

  it('fans out to NO approvers — the plan was the approval', async () => {
    const snap = await createActionIntent(planAuth, {
      toolName: 'google_suspend_user', source: 'mcp_api', input: {},
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    });
    expect(snap.approvalRequestIds).toEqual([]);
    expect(snap.fanOutUserIds).toEqual([]);
  });

  it('a SECRET-BEARING tool can never ride a plan', async () => {
    await expect(createActionIntent(planAuth, {
      toolName: 'google_reset_password', source: 'mcp_api', input: {},
      task: TASK_CTX, planApproval: { approvalId: 'p1', ordinal: 0 },
    })).rejects.toMatchObject({ code: 'plan_approval_invalid' });
  });

  it('reserves the operation, so a replay of the same ordinal is at-most-once', async () => {
    const a = await createActionIntent(planAuth, { /* …as above… */ } as never);
    const b = await createActionIntent(planAuth, { /* identical */ } as never);
    expect(b.id).toBe(a.id);
    expect(await countOperations(TASK_CTX.taskId)).toBe(1);
  });
});
```

> The helper names (`planAuth`, `humanAuth`, `TASK_CTX`, `stubMembership`, `widenLiveAgentPolicy`, `readIntentRow`, `countOperations`) follow whatever `intentService.test.ts` already uses for its agent fixtures. **Read the top 120 lines of that file and reuse its existing fixtures and mock style; do not introduce a second one.**

- [ ] **Step 3: Run it red**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.test.ts`
Expected: FAIL on the new cases only; every pre-existing case still passes. If a pre-existing case breaks, the fixtures were rewritten — undo and reuse them.

- [ ] **Step 4: Implement the three changes in `intentService.ts`**

**(a) `CreateActionIntentInput`** (the interface at `:160-272`) gains, after `task`:

```ts
  /**
   * E4 — plan approval (Recipe Library spec §6.4). Present ONLY on a child
   * effect being dispatched under an already-approved plan. It is what lets a
   * non-agent principal carry `task` context: the run-linkage proof an agent
   * intent uses is replaced by a stronger, row-backed membership proof read in
   * this same transaction (see the wave plan's D-E4-2). Requires `task`.
   */
  planApproval?: { approvalId: string; ordinal: number };
```

**(b) Relax the Fact-2 throw at `:1124-1132`** to:

```ts
  if (input.task !== undefined) {
    // E4: a human principal may carry task context ONLY together with a plan
    // approval, whose membership check below is strictly stronger than the
    // run-linkage check an agent intent gets (plan D-E4-2).
    if (auth.principal.kind !== 'ai_agent' && !input.planApproval) {
      throw new ActionIntentError(
        `task context is only valid for the ai_agent principal (got principal '${auth.principal.kind}')`,
        'task_context_not_allowed',
      );
    }
```
Leave the rest of the block (the explicit-key rejection and the zod parse) byte-identical.

**(c) A new block immediately after the guardrail check and before the digest computation**, holding both gates:

```ts
  // ─────────────────────────────────────────────────────────────────────────
  // E4 — PLAN APPROVAL and the AGENT TOOL-ALLOWLIST CEILING
  // (Recipe Library spec §6.4; risk §11 "Plan approval becomes a four-eyes
  //  bypass"). Both run BEFORE anything is written, and both are re-run at
  //  release by revalidateApprovedIntentForRelease — a gate checked in only
  //  one place cannot revoke.
  // ─────────────────────────────────────────────────────────────────────────
  if (input.planApproval) {
    if (!taskContext) {
      throw new ActionIntentError(
        'planApproval requires task context — membership is keyed on (task, revision, ordinal)',
        'plan_approval_invalid',
      );
    }
    // Spec §6.4: secret-bearing effects are EXCLUDED from plan approval and
    // keep their individual intent. Refused here as well as in
    // splitSecretBearingEffects, because this is the chokepoint an attacker
    // would aim at if they could call the service directly.
    if (isSecretBearingTool(input.toolName)) {
      throw new ActionIntentError(
        `${input.toolName} mints a credential and cannot be dispatched under a plan approval`,
        'plan_approval_invalid',
      );
    }
    const membership = await checkPlanEffectMembership(db, {
      orgId, taskId: taskContext.taskId, planRevision: /* read from the approval row */ 0,
      ordinal: input.planApproval.ordinal,
      toolName: input.toolName,
      argumentDigest,
    });
    if (!membership.ok) {
      throw new ActionIntentError(
        `plan approval does not authorize this effect: ${membership.refusal} (${membership.detail})`,
        'plan_approval_invalid',
      );
    }
    planApprovalDecision = membership;
  }

  // THE CEILING. A plan cannot name a tool the admitting agent's FROZEN policy
  // snapshot does not allow. Frozen, not live: a policy widened after the task
  // was admitted must not retroactively authorize an effect the approver's
  // plan was built under (Operator spec P3-4 freezes the recipe version for
  // exactly this reason), and a policy NARROWED after admission must revoke —
  // which the release-side re-check delivers.
  if (taskContext) {
    const allowed = await loadTaskAgentToolAllowlist(orgId, taskContext.taskId);
    if (allowed && !allowed.has(input.toolName)) {
      throw new ActionIntentError(
        `${input.toolName} is not in the admitting agent's tool allowlist for this task`,
        'tool_not_in_agent_allowlist',
      );
    }
  }
```

> **`argumentDigest` must be in scope here.** It is computed at `:1537-1538`. Either move this block below that computation (preferred — the membership check needs the digest) or hoist the two lines. Whichever the executor picks, the block must still run **before** the insert and before `runHumanFanout`.

**(d) `planApprovalDecision` drives the insert.** Where the insert at `:1854-1960` already branches for ticket-autonomy and the script lane, add the third arm:

```ts
        ...(planApprovalDecision?.ok
          ? {
              status: 'approved' as const,
              decidedVia: 'plan_approval' as const,
              decidedAt: now,
              decidedByUserId: planApprovalDecision.approverUserId,
              // Same 10-minute release lease every approved intent gets.
              releaseBy: new Date(now.getTime() + RELEASE_LEASE_MS),
              // The requester IS the approver here (plan D-E4-2): the effect
              // executes under their live authority, so the release path's
              // actor rebuild and RBAC re-check land on the right person.
              requestedByUserId: planApprovalDecision.approverUserId,
            }
          : {}),
```
and skip `runHumanFanout` for it exactly as the ticket-autonomy arm does, enqueueing the `intent_approved` outbox row instead.

**(e) `loadTaskAgentToolAllowlist`** — a small private reader: join `ai_operator_tasks` → `ai_agents` → the task's frozen snapshot. Read how `agentReleaseAuthority.ts:249-290` reaches the frozen snapshot (`ai_agent_runs.policy_snapshot.effective.actAssets`) and use the **same accessor path**; for a task the snapshot lives on `ai_operator_plan_approvals.policy_snapshot_digest`'s source, which Task 6 stamped. Returning `null` means "no snapshot recorded" and, per fail-closed, must be treated as **refuse**, not allow — write it as `if (!allowed || !allowed.has(...)) throw`.

- [ ] **Step 5: Run green**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.test.ts src/services/actionIntents/intentService.scope.test.ts src/services/actionIntents/intentService.tier2Agent.test.ts src/services/actionIntents/intentService.ticketAutonomy.test.ts src/services/actionIntents/intentOperationIdentity.test.ts`
Expected: 5 files, all PASS — the four pre-existing files with **no edits**.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.test.ts
git commit -m "$(cat <<'EOF'
feat(api): agent tool-allowlist ceiling + the planApproval branch (E4)

Recipe Library spec §6.4. The ceiling reads the task's FROZEN snapshot, so a
policy widened after admission cannot retroactively authorize an effect.
planApproval lets a human-shaped intent carry task context only when a
row-backed membership proof accompanies it — strictly stronger than the
run-linkage proof it replaces. Secret-bearing tools are refused outright.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `revalidateRelease.ts` — the `plan_approval` arm

**Files:**
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.ts`
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.test.ts` (append)

**This is the check that actually stops a bypass.** Everything at mint time is advisory: an approver can reject, a policy can narrow, a plan can be superseded, and a task can move on — all after the intent row exists and before the release worker claims it. The mint-time gates exist to fail fast; **this** one exists to fail closed.

**Interfaces:**
- Produces: two new `errorCode` strings — `plan_approval_revoked`, `tool_not_in_agent_allowlist`.

- [ ] **Step 1: Write the failing tests** (append to `revalidateRelease.test.ts`)

```ts
/**
 * E4 — release-time revalidation of a plan-approved child effect.
 *
 * Modelled on the shipped `script_reviewer` lane arm (revalidateRelease.ts:275-283):
 * an intent with NO approval row is admitted only because a stronger, typed
 * proof revalidates against CURRENT state. Here that proof is
 * `checkPlanEffectMembership`, read from rows inside the release transaction.
 *
 * The window these cases describe is real and long: a plan intent can sit for
 * 24 hours (mcp_api expiry), and every one of these transitions can happen
 * inside it.
 */
describe('revalidateApprovedIntentForRelease: decided_via = plan_approval (E4)', () => {
  it('ADMITS a child effect that is still a member of a still-approved plan', async () => {
    stubMembership({ ok: true, approvalId: 'p1', approverUserId: 'u-approver', idempotencyClass: 'idempotent' });
    const res = await revalidateApprovedIntentForRelease(planChildIntent(), null);
    expect(res.ok).toBe(true);
  });

  it('REFUSES when the plan was SUPERSEDED after the intent was minted', async () => {
    stubMembership({ ok: false, refusal: 'plan_superseded', detail: 'superseded by revision 4' });
    const res = await revalidateApprovedIntentForRelease(planChildIntent(), null);
    expect(res).toMatchObject({ ok: false, errorCode: 'plan_approval_revoked' });
  });

  it('REFUSES when the task\'s revision moved, even with the approval row untouched', async () => {
    stubMembership({ ok: false, refusal: 'revision_moved', detail: 'task is at revision 4, plan is 3' });
    const res = await revalidateApprovedIntentForRelease(planChildIntent(), null);
    expect(res).toMatchObject({ ok: false, errorCode: 'plan_approval_revoked' });
  });

  it('REFUSES when the approval EXPIRED', async () => {
    stubMembership({ ok: false, refusal: 'plan_expired', detail: 'approval expired' });
    expect(await revalidateApprovedIntentForRelease(planChildIntent(), null))
      .toMatchObject({ ok: false, errorCode: 'plan_approval_revoked' });
  });

  it('REFUSES when the intent\'s arguments no longer digest to the approved effect', async () => {
    stubMembership({ ok: false, refusal: 'argument_digest_mismatch', detail: 'ordinal 2' });
    expect(await revalidateApprovedIntentForRelease(planChildIntent(), null))
      .toMatchObject({ ok: false, errorCode: 'plan_approval_revoked' });
  });

  it('REFUSES when the tool left the admitting agent\'s frozen allowlist after approval', async () => {
    stubMembership({ ok: true, approvalId: 'p1', approverUserId: 'u-approver', idempotencyClass: 'idempotent' });
    stubTaskAllowlist(new Set(['google_suspend_user'])); // the intent names google_signout
    expect(await revalidateApprovedIntentForRelease(planChildIntent({ actionName: 'google_signout' }), null))
      .toMatchObject({ ok: false, errorCode: 'tool_not_in_agent_allowlist' });
  });

  it('a plan-approved intent is NOT admitted through the noApprovalRowRequired back door alone', async () => {
    // isSystemDecided must NOT grow a blanket plan_approval arm: without the
    // membership call, `decided_via='plan_approval'` written by any path would
    // be self-authorizing. Membership stubbed to refuse; the intent must still
    // be refused even though decided_via says plan_approval.
    stubMembership({ ok: false, refusal: 'plan_approval_missing', detail: 'no row' });
    expect(await revalidateApprovedIntentForRelease(planChildIntent(), null))
      .toMatchObject({ ok: false, errorCode: 'plan_approval_revoked' });
  });

  it('the PLAN intent itself still takes the ORDINARY human-approval path', async () => {
    // operator_plan is decided by real approvers on real approval_requests
    // rows. It must go through check (a) — winningApproval + digest — exactly
    // like any other four-eyes intent, or the primitive that grants the
    // authority would be the one thing not subject to it.
    const res = await revalidateApprovedIntentForRelease(
      planIntent({ actionName: 'operator_plan' }), null,
    );
    expect(res).toMatchObject({ ok: false, errorCode: 'digest_mismatch' });
  });

  it('still recomputes the argument digest from stored arguments (check a2) for a plan child', async () => {
    stubMembership({ ok: true, approvalId: 'p1', approverUserId: 'u-approver', idempotencyClass: 'idempotent' });
    const tampered = planChildIntent();
    tampered.arguments = { userEmail: 'someone-else@customer.example', reason: 'offboarding' };
    expect(await revalidateApprovedIntentForRelease(tampered, null))
      .toMatchObject({ ok: false, errorCode: 'digest_mismatch' });
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease.test.ts`
Expected: FAIL on the new cases; every pre-existing case passes.

- [ ] **Step 3: Implement**

Three edits, each placed to mirror the `script_reviewer` arm it is modelled on:

**(a) The lane-style evidence call**, beside `laneEvidence` at `:275-283`:

```ts
  // E4 — the PLAN-APPROVAL lane (Recipe Library spec §6.4).
  //
  // Same structure as the script lane immediately above, and for the same
  // reason: this intent carries NO approval row of its own, so it is admitted
  // only because a stronger, row-backed proof revalidates against CURRENT
  // state. The proof is membership of the approved effect set — read here,
  // inside the release transaction, never trusted from the intent's own
  // columns. `decided_via = 'plan_approval'` alone authorizes NOTHING; a
  // forged row with that value and no live membership fails right here.
  const planEvidence = !winningApproval && intent.decidedVia === 'plan_approval'
    ? await checkPlanEffectMembership(db, {
        orgId: intent.orgId,
        taskId: intent.taskId!,
        planRevision: await readTaskRevision(intent.orgId, intent.taskId!),
        ordinal: planOrdinalFromOperationKey(intent.operationKey!),
        toolName: intent.actionName,
        argumentDigest: intent.argumentDigest,
      })
    : null;
  if (planEvidence && !planEvidence.ok) {
    return {
      ok: false,
      errorCode: 'plan_approval_revoked',
      details: { refusal: planEvidence.refusal, reason: planEvidence.detail },
    };
  }
```

> `planOrdinalFromOperationKey` is a tiny pure helper exported from `services/aiOperator/operationKey.ts`: the ordinal is the final `n<N>` segment of the key `buildTaskOperationKey` builds (`operationKey.ts:56-62`, format `step:tool:target:r<rev>:n<ordinal>`). Add it there with a unit test rather than re-parsing inline, so the format has exactly one parser. If parsing fails, return `-1`, which can never be a member — fail closed.

**(b) Extend `noApprovalRowRequired`** (`:302-307`) with the plan arm, mirroring the script-lane clause **exactly** — it consults the evidence, never the column:

```ts
      : intent.decidedVia === 'plan_approval'
        ? planEvidence?.ok === true
```

**(c) The release-side ceiling**, immediately after check (b)'s tier comparison:

```ts
  // E4 — the ALLOWLIST ceiling, re-run at release. Its mint-time twin in
  // createActionIntent fails fast; this one is what makes a NARROWED agent
  // policy actually revoke an approved-but-undispatched effect. Scoped to
  // task-linked intents so no other release path changes behaviour.
  if (intent.taskId) {
    const allowed = await loadTaskAgentToolAllowlist(intent.orgId, intent.taskId);
    if (!allowed || !allowed.has(intent.actionName)) {
      return {
        ok: false,
        errorCode: 'tool_not_in_agent_allowlist',
        details: { toolName: intent.actionName, hadSnapshot: !!allowed },
      };
    }
  }
```
Export `loadTaskAgentToolAllowlist` from `services/aiOperator/planApproval.ts` (Task 6) so mint and release read **one** implementation. A second copy is how the two would drift, and the drift direction that matters is "release is looser than mint".

- [ ] **Step 4: Run green, including the two release-path suites that must not change**

Run: `cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease.test.ts src/services/actionIntents/agentReleaseAuthority.test.ts src/services/actionIntents/scriptReviewerRevalidate.test.ts src/jobs/intentReleaseWorker*.test.ts`
Expected: all PASS, with only `revalidateRelease.test.ts` edited.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/actionIntents/revalidateRelease.ts apps/api/src/services/actionIntents/revalidateRelease.test.ts apps/api/src/services/aiOperator/operationKey.ts apps/api/src/services/aiOperator/operationKey.test.ts
git commit -m "$(cat <<'EOF'
feat(api): release-time plan-approval membership + allowlist re-check (E4)

Recipe Library spec §6.4, §11. decided_via='plan_approval' authorizes
nothing on its own: admission comes from a row-backed membership proof read
inside the release transaction, exactly like the script lane's evidence arm.
The allowlist ceiling is re-run here so a narrowed policy revokes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The provider-neutral `EffectProbe` registry and the M365 adapter

**Files:**
- Create: `apps/api/src/services/aiOperator/effectProbes/index.ts`
- Create: `apps/api/src/services/aiOperator/effectProbes/index.test.ts`
- Create: `apps/api/src/services/aiOperator/effectProbes/m365.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EffectProbeState = 'satisfied' | 'unsatisfied' | 'unknown';
  export interface EffectProbeResult { state: EffectProbeState; observedAt: Date; detail: string }
  export interface EffectProbeContext {
    orgId: string; taskId: string; planRevision: number;
    /** When the write was (or is about to be) requested. Session-revocation
     *  style criteria compare a provider timestamp against this. */
    effectRequestedAt: Date;
    /** `pre` runs BEFORE the write and decides whether to skip it; `post` is
     *  the verification adapter. A probe may legitimately answer differently. */
    phase: 'pre' | 'post';
  }
  export type EffectProbe = (effect: PlannedEffect, ctx: EffectProbeContext) => Promise<EffectProbeResult>;
  export function registerEffectProbe(toolName: string, probe: EffectProbe): void;
  export function getEffectProbe(toolName: string): EffectProbe | undefined;
  export function listProbedTools(): string[];
  export async function probeEffect(effect: PlannedEffect, ctx: EffectProbeContext): Promise<EffectProbeResult>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/effectProbes/index.test.ts
/**
 * The provider-neutral probe registry (Recipe Library spec §6.6:
 * "Every effect is therefore probe → write → probe").
 *
 * The registry's contract is almost entirely about what happens when it does
 * NOT know something. `unknown` is the default, and `unknown` means handoff,
 * never `verified` — Operator spec §13: "Failed/inconclusive verification
 * cannot produce 'Resolved'". A registry that returned `satisfied` for an
 * unregistered tool would certify effects nobody observed, which is the exact
 * false-verified-success the release gate forbids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEffectProbesForTest, getEffectProbe, listProbedTools, probeEffect, registerEffectProbe,
} from './index';
import type { PlannedEffect } from '../recipes/types';

const effect: PlannedEffect = {
  ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
  targetId: 'c1', accountExternalId: '101',
  canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
};
const ctx = {
  orgId: 'o1', taskId: 't1', planRevision: 1,
  effectRequestedAt: new Date('2026-09-17T10:00:00Z'), phase: 'post' as const,
};

beforeEach(() => __resetEffectProbesForTest());

describe('effect probe registry', () => {
  it('returns UNKNOWN for a tool with no registered probe — never satisfied', () => {
    expect(getEffectProbe('google_suspend_user')).toBeUndefined();
    return expect(probeEffect(effect, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });

  it('names the tool in the unknown detail, so a handoff summary is actionable', async () => {
    const r = await probeEffect(effect, ctx);
    expect(r.detail).toContain('google_suspend_user');
    expect(r.observedAt).toBeInstanceOf(Date);
  });

  it('dispatches to a registered probe by tool name', async () => {
    registerEffectProbe('google_suspend_user', async () => ({
      state: 'satisfied', observedAt: new Date('2026-09-17T10:00:05Z'), detail: 'suspended=true',
    }));
    await expect(probeEffect(effect, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(listProbedTools()).toEqual(['google_suspend_user']);
  });

  it('a THROWING probe degrades to unknown and never propagates', async () => {
    // A provider outage must not escape into the coordinator: the intent is
    // already dispatched or about to be, and an escaping error would strand
    // the task until the stale-lease reaper rewrites the cause.
    registerEffectProbe('google_suspend_user', async () => { throw new Error('Graph 503'); });
    const r = await probeEffect(effect, ctx);
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('503');
  });

  it('a probe that exceeds the deadline degrades to unknown', async () => {
    registerEffectProbe('google_suspend_user', () => new Promise(() => {}));
    vi.useFakeTimers();
    const p = probeEffect(effect, { ...ctx });
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(p).resolves.toMatchObject({ state: 'unknown' });
    vi.useRealTimers();
  });

  it('REFUSES to register two probes for one tool name', () => {
    registerEffectProbe('google_suspend_user', async () => ({ state: 'unknown', observedAt: new Date(), detail: '' }));
    expect(() => registerEffectProbe('google_suspend_user', async () =>
      ({ state: 'satisfied', observedAt: new Date(), detail: '' }))).toThrow(/already registered/);
  });

  it('bounds the detail string so it fits the event and step columns', async () => {
    registerEffectProbe('google_suspend_user', async () => ({
      state: 'unsatisfied', observedAt: new Date(), detail: 'x'.repeat(5000),
    }));
    const r = await probeEffect(effect, ctx);
    expect(r.detail.length).toBeLessThanOrEqual(1000);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectProbes/index.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement `effectProbes/index.ts`**

```ts
/**
 * The provider-neutral effect-probe registry (Recipe Library spec §6.6).
 *
 * "There is no executor-side dedup store and neither Graph nor the Google
 * Directory API takes an idempotency key. Every effect is therefore
 * probe → write → probe."
 *
 * THE DEFAULT IS `unknown`, AND THAT IS THE DESIGN. An unregistered tool, a
 * throwing probe and a slow probe all answer `unknown`, and `unknown` can
 * never produce a verified outcome (Operator spec §13). The cost of the
 * default being `unknown` is a handoff; the cost of it being `satisfied`
 * would be Breeze telling an MSP that a departed employee's access was
 * revoked when nobody looked.
 *
 * Probes are keyed by TOOL NAME, not by provider action id, because the
 * approved effect set and `ai_operator_operations` are both keyed by tool
 * name. The M365 adapter (./m365) translates to W05's action-id-keyed
 * `probeM365Effect`.
 */
import { captureException } from '../../sentry';
import type { PlannedEffect } from '../recipes/types';

export type EffectProbeState = 'satisfied' | 'unsatisfied' | 'unknown';

export interface EffectProbeResult {
  state: EffectProbeState;
  observedAt: Date;
  detail: string;
}

export interface EffectProbeContext {
  orgId: string;
  taskId: string;
  planRevision: number;
  effectRequestedAt: Date;
  phase: 'pre' | 'post';
}

export type EffectProbe = (
  effect: PlannedEffect,
  ctx: EffectProbeContext,
) => Promise<EffectProbeResult>;

/** Mirrors `ai_operator_task_events_detail_len_chk` head-room; the detail is
 *  also written to a step row and an operation result. */
const MAX_PROBE_DETAIL_CHARS = 1000;

/**
 * A provider read that has not answered in 30s is not going to make the
 * coordinator's decision better. The task holds NOTHING while waiting
 * (taskCoordinator.ts invariant 1), so a hung probe would burn a lease, not a
 * thread — but it would still delay a dispatch behind a third-party outage.
 */
const PROBE_TIMEOUT_MS = 30_000;

const PROBES = new Map<string, EffectProbe>();

export function registerEffectProbe(toolName: string, probe: EffectProbe): void {
  if (PROBES.has(toolName)) {
    // Two probes for one tool is a merge accident, and the failure mode is
    // that whichever loaded last silently decides verification for a
    // destructive identity effect. Refuse loudly at import time.
    throw new Error(`effect probe for '${toolName}' is already registered`);
  }
  PROBES.set(toolName, probe);
}

export function getEffectProbe(toolName: string): EffectProbe | undefined {
  return PROBES.get(toolName);
}

export function listProbedTools(): string[] {
  return [...PROBES.keys()].sort();
}

/** Test-only. Never called from product code. */
export function __resetEffectProbesForTest(): void {
  PROBES.clear();
}

function unknown(detail: string): EffectProbeResult {
  return { state: 'unknown', observedAt: new Date(), detail: detail.slice(0, MAX_PROBE_DETAIL_CHARS) };
}

export async function probeEffect(
  effect: PlannedEffect,
  ctx: EffectProbeContext,
): Promise<EffectProbeResult> {
  const probe = PROBES.get(effect.toolName);
  if (!probe) {
    return unknown(
      `no verification probe is registered for '${effect.toolName}', so this effect cannot be proven; `
      + 'the task will hand off rather than report it verified',
    );
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      probe(effect, ctx),
      new Promise<EffectProbeResult>((resolve) => {
        timer = setTimeout(
          () => resolve(unknown(`verification probe for '${effect.toolName}' did not answer within ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { ...result, detail: result.detail.slice(0, MAX_PROBE_DETAIL_CHARS) };
  } catch (err) {
    // A provider outage is not a verification failure and must not be
    // reported as one: `unsatisfied` would say "we looked and it is not done",
    // which invites a retry of a possibly-completed destructive effect.
    captureException(err instanceof Error ? err : new Error(String(err)));
    return unknown(
      `verification probe for '${effect.toolName}' failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Implement the M365 adapter `effectProbes/m365.ts`**

```ts
/**
 * M365 arm of the probe registry — a translation layer, nothing more.
 *
 * W05 (wave M1) ships `probeM365Effect(actionId, args, ctx)` in
 * `services/m365ControlPlane/effectProbes.ts`, keyed by ACTION ID and
 * returning `observedAt` as an ISO STRING. The registry here is keyed by TOOL
 * NAME and uses `Date`. This file is the only place those two vocabularies
 * meet (see the wave plan's D-E4-6).
 *
 * IT REGISTERS NOTHING WHEN M1 HAS NOT MERGED. The import is guarded, and an
 * unregistered tool answers `unknown`, which by §6.6 means handoff and never a
 * false verified success. E4 therefore ships and is testable without M1.
 */
import { registerEffectProbe, type EffectProbe } from './index';

export async function registerM365EffectProbes(): Promise<void> {
  let probeM365Effect: unknown;
  let M365_HEADLESS_ACTIONS: Record<string, string>;
  try {
    ({ probeM365Effect } = await import('../../m365ControlPlane/effectProbes'));
    ({ M365_HEADLESS_ACTIONS } = await import('../../m365ToolsHeadless'));
  } catch {
    // M1 has not merged. Deliberate no-op; see the module docstring.
    return;
  }
  if (typeof probeM365Effect !== 'function') return;

  for (const [toolName, actionId] of Object.entries(M365_HEADLESS_ACTIONS)) {
    const probe: EffectProbe = async (effect, ctx) => {
      const result = await (probeM365Effect as (
        a: string, args: unknown, c: { orgId: string; effectRequestedAt: Date },
      ) => Promise<{ state: 'satisfied' | 'unsatisfied' | 'unknown'; observedAt: string; detail: string }>)(
        actionId,
        { type: actionId, ...effect.canonicalArguments },
        { orgId: ctx.orgId, effectRequestedAt: ctx.effectRequestedAt },
      );
      return {
        state: result.state,
        // W05 returns an ISO string; an unparseable one becomes "now" rather
        // than an Invalid Date that would silently poison every comparison.
        observedAt: Number.isNaN(Date.parse(result.observedAt)) ? new Date() : new Date(result.observedAt),
        detail: result.detail,
      };
    };
    registerEffectProbe(toolName, probe);
  }
}
```

Wire it once, at the same place the API registers its other startup singletons: run `grep -rn "initializeIntentReleaseWorker\|registerAiOperatorTools" apps/api/src/index.ts | head` and call `await registerM365EffectProbes();` and `registerGoogleEffectProbes();` (Task 10) beside them, with a comment naming this plan.

- [ ] **Step 5: Run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectProbes/index.test.ts`
Expected: PASS — 1 file, 7 tests.

- [ ] **Step 6: Commit**

```
git add apps/api/src/services/aiOperator/effectProbes/
git commit -m "$(cat <<'EOF'
feat(api): provider-neutral effect-probe registry (E4)

Recipe Library spec §6.6. Unregistered, throwing and slow probes all answer
`unknown`, which can never produce a verified outcome (Operator spec §13).
The M365 arm adapts W05's action-id-keyed probeM365Effect and registers
nothing when M1 has not merged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The eight Google probes

**Files:**
- Create: `apps/api/src/services/aiOperator/effectProbes/google.ts`
- Create: `apps/api/src/services/aiOperator/effectProbes/google.test.ts`

**Interfaces:**
- Consumes: `resolveContextByOrg`, `type GoogleToolContext` (`../../aiToolsGoogle`); `getDirectoryClient`, `getGmailClient`, `getLicensingClient` (`../../googleClient`); `registerEffectProbe` (`./index`).
- Produces: `registerGoogleEffectProbes()`, and one exported probe per tool so each is unit-testable in isolation.

**The eight probes and their exact basis** (all verified against the write paths they mirror — see the wave plan's D-E4-7 for the table and for why two of them are honestly `unknown`):

| Tool | Read | `satisfied` when |
|---|---|---|
| `google_suspend_user` | `dir.users.get({ userKey })` | `data.suspended === true` |
| `google_remove_from_group` | `dir.groups.list({ userKey, maxResults: 200 })` | no returned group's `email` equals `groupEmail` |
| `google_remove_license` | `lic.licenseAssignments.listForProduct({ productId, customerId: 'my_customer', maxResults: 100 })` | no item has `userId === userEmail && skuId === skuId` |
| `google_set_vacation` | `gmail.users.settings.getVacation({ userId: 'me' })` | `enableAutoReply === true` and, when `message` was given, `responseBodyPlainText`/`responseBodyHtml` contains it |
| `google_set_forwarding` | `gmail.users.settings.getAutoForwarding()` + `forwardingAddresses.get({ forwardingEmail })` | `enabled === true`, `emailAddress === forwardTo`, **and** `verificationStatus === 'accepted'` |
| `google_add_mail_delegate` | `gmail.users.settings.delegates.list({ userId: 'me' })` | a delegate matches `delegateEmail` with `verificationStatus === 'accepted'` |
| `google_signout` | — | **always `unknown`**: the Directory user resource exposes no session-validity field |
| `google_wipe_mobile_device` | `dir.users.get` then `dir.mobiledevices.list({ customerId: 'my_customer', query: 'email:'+primaryEmail })`, exact-matching each device's `email[]` against `primaryEmail` | every matched device's `status` is `WIPING` or `WIPED`; **`unknown`** when the matched list is empty |

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/effectProbes/google.test.ts
/**
 * The Google half of probe → write → probe (Recipe Library spec §6.6 and
 * §6.3's granular offboarding tools).
 *
 * Every probe MIRRORS a shipped write in `services/aiToolsGoogle.ts` — same
 * client accessor, same impersonation, same argument names — because a probe
 * that reads a different scope than the write writes is a probe that certifies
 * the wrong thing. Google's client is mocked here; the real credential path is
 * exercised only in a lab run (spec §9, gate (e)).
 *
 * TWO PROBES RETURN `unknown` BY DESIGN and their tests assert exactly that.
 * `google_signout` has no observable end state; the same is true of M365's
 * `reset_password` in W05. Asserting it keeps a later author from "fixing" it
 * into a lastLoginTime heuristic that would certify sessions nobody revoked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const usersGet = vi.fn();
const groupsList = vi.fn();
const mobileList = vi.fn();
const licenseList = vi.fn();
const getVacation = vi.fn();
const getAutoForwarding = vi.fn();
const forwardingGet = vi.fn();
const delegatesList = vi.fn();

vi.mock('../../googleClient', () => ({
  getDirectoryClient: () => ({
    users: { get: usersGet },
    groups: { list: groupsList },
    mobiledevices: { list: mobileList },
  }),
  getGmailClient: () => ({
    users: { settings: {
      getVacation, getAutoForwarding,
      forwardingAddresses: { get: forwardingGet },
      delegates: { list: delegatesList },
    } },
  }),
  getLicensingClient: () => ({ licenseAssignments: { listForProduct: licenseList } }),
}));
vi.mock('../../aiToolsGoogle', () => ({
  resolveContextByOrg: vi.fn(async () => ({ conn: { adminEmail: 'admin@customer.example' }, keyJson: '{}' })),
}));

import {
  probeGoogleAddMailDelegate, probeGoogleRemoveFromGroup, probeGoogleRemoveLicense,
  probeGoogleSetForwarding, probeGoogleSetVacation, probeGoogleSignout,
  probeGoogleSuspendUser, probeGoogleWipeMobileDevice,
} from './google';
import type { PlannedEffect } from '../recipes/types';

const ctx = {
  orgId: 'o1', taskId: 't1', planRevision: 1,
  effectRequestedAt: new Date('2026-09-17T10:00:00Z'), phase: 'post' as const,
};
const eff = (toolName: string, canonicalArguments: Record<string, unknown>): PlannedEffect => ({
  ordinal: 0, toolName, provider: 'google', targetId: 'c1', accountExternalId: '101', canonicalArguments,
});

beforeEach(() => vi.clearAllMocks());

describe('probeGoogleSuspendUser', () => {
  const e = eff('google_suspend_user', { userEmail: 'dana@customer.example', reason: 'offboarding' });
  it('satisfied when the directory says suspended', async () => {
    usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example', suspended: true } });
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied when the account is still active — the pre-probe case that lets the write run', async () => {
    usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example', suspended: false } });
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown — NOT satisfied — when the user is gone (404)', async () => {
    // A deleted account is not proof the SUSPEND we were asked for happened.
    usersGet.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));
    await expect(probeGoogleSuspendUser(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('probeGoogleRemoveFromGroup', () => {
  const e = eff('google_remove_from_group', {
    userEmail: 'dana@customer.example', groupEmail: 'sales@customer.example', reason: 'offboarding',
  });
  it('satisfied when the group is absent from the membership list', async () => {
    groupsList.mockResolvedValue({ data: { groups: [{ email: 'all@customer.example' }] } });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('satisfied on an EMPTY list — no memberships is the desired end state', async () => {
    groupsList.mockResolvedValue({ data: {} });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied while the membership is still there, case-insensitively', async () => {
    groupsList.mockResolvedValue({ data: { groups: [{ email: 'Sales@Customer.Example' }] } });
    await expect(probeGoogleRemoveFromGroup(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
});

describe('probeGoogleRemoveLicense', () => {
  const e = eff('google_remove_license', {
    userEmail: 'dana@customer.example', productId: 'Google-Apps', skuId: '1010020020', reason: 'offboarding',
  });
  it('satisfied when no assignment matches the user AND sku', async () => {
    licenseList.mockResolvedValue({ data: { items: [{ userId: 'other@customer.example', skuId: '1010020020' }] } });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied while the assignment stands', async () => {
    licenseList.mockResolvedValue({ data: { items: [{ userId: 'dana@customer.example', skuId: '1010020020' }] } });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown when the page is full — a truncated list cannot prove ABSENCE', async () => {
    // 100 items is maxResults; absence from a truncated page is not absence.
    licenseList.mockResolvedValue({
      data: { items: Array.from({ length: 100 }, (_, i) => ({ userId: `u${i}@customer.example`, skuId: '1010020020' })) },
    });
    await expect(probeGoogleRemoveLicense(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('probeGoogleSetVacation', () => {
  const e = eff('google_set_vacation', {
    userEmail: 'dana@customer.example', enable: true, message: 'Dana has left.', reason: 'offboarding',
  });
  it('satisfied when auto-reply is on and carries the approved message', async () => {
    getVacation.mockResolvedValue({ data: { enableAutoReply: true, responseBodyPlainText: 'Dana has left.' } });
    await expect(probeGoogleSetVacation(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied when auto-reply is on with DIFFERENT text — the approver approved the text', async () => {
    getVacation.mockResolvedValue({ data: { enableAutoReply: true, responseBodyPlainText: 'On holiday.' } });
    await expect(probeGoogleSetVacation(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
});

describe('probeGoogleSetForwarding', () => {
  const e = eff('google_set_forwarding', {
    userEmail: 'dana@customer.example', forwardTo: 'manager@customer.example', keepCopy: true, reason: 'offboarding',
  });
  it('satisfied only when enabled, addressed correctly AND verified', async () => {
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'manager@customer.example' } });
    forwardingGet.mockResolvedValue({ data: { verificationStatus: 'accepted' } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('UNSATISFIED when forwarding is configured but the destination is unverified', async () => {
    // Gmail will not deliver until the owner confirms; the write path already
    // refuses to report this as done (aiToolsGoogle.ts:791-800) and the probe
    // must hold the same bar or it would certify mail that never forwards.
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'manager@customer.example' } });
    forwardingGet.mockResolvedValue({ data: { verificationStatus: 'pending' } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unsatisfied when forwarding points somewhere else', async () => {
    getAutoForwarding.mockResolvedValue({ data: { enabled: true, emailAddress: 'someone@evil.example' } });
    await expect(probeGoogleSetForwarding(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
});

describe('probeGoogleAddMailDelegate', () => {
  const e = eff('google_add_mail_delegate', {
    userEmail: 'dana@customer.example', delegateEmail: 'manager@customer.example', reason: 'offboarding',
  });
  it('satisfied on an accepted delegate', async () => {
    delegatesList.mockResolvedValue({ data: { delegates: [{ delegateEmail: 'manager@customer.example', verificationStatus: 'accepted' }] } });
    await expect(probeGoogleAddMailDelegate(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied on a pending delegate', async () => {
    delegatesList.mockResolvedValue({ data: { delegates: [{ delegateEmail: 'manager@customer.example', verificationStatus: 'pending' }] } });
    await expect(probeGoogleAddMailDelegate(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
});

describe('probeGoogleSignout', () => {
  it('is ALWAYS unknown and says why — Directory exposes no session-validity field', async () => {
    const r = await probeGoogleSignout(
      eff('google_signout', { userEmail: 'dana@customer.example', reason: 'offboarding' }), ctx,
    );
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/no observable end state|session/i);
    expect(usersGet).not.toHaveBeenCalled();
  });
});

describe('probeGoogleWipeMobileDevice', () => {
  const e = eff('google_wipe_mobile_device', { userEmail: 'dana@customer.example', reason: 'offboarding' });
  it('satisfied when every EXACT-matched device reports WIPING or WIPED', async () => {
    usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example' } });
    mobileList.mockResolvedValue({ data: { mobiledevices: [
      { resourceId: 'r1', email: ['dana@customer.example'], status: 'WIPING' },
      { resourceId: 'r2', email: ['dana@customer.example'], status: 'WIPED' },
    ] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('IGNORES a device that does not carry the exact account — mirrors the write path\'s gate', async () => {
    usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example' } });
    mobileList.mockResolvedValue({ data: { mobiledevices: [
      { resourceId: 'r1', email: ['dana@customer.example'], status: 'WIPED' },
      { resourceId: 'r2', email: ['dana2@customer.example'], status: 'APPROVED' },
    ] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'satisfied' });
  });
  it('unsatisfied while a matched device is still APPROVED', async () => {
    usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example' } });
    mobileList.mockResolvedValue({ data: { mobiledevices: [{ resourceId: 'r1', email: ['dana@customer.example'], status: 'APPROVED' }] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'unsatisfied' });
  });
  it('unknown — NOT satisfied — when no device matches', async () => {
    // "No devices" is indistinguishable from "we cannot see the devices".
    // Reporting satisfied would certify a wipe that may never have been needed
    // or may never have happened.
    usersGet.mockResolvedValue({ data: { primaryEmail: 'dana@customer.example' } });
    mobileList.mockResolvedValue({ data: { mobiledevices: [] } });
    await expect(probeGoogleWipeMobileDevice(e, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectProbes/google.test.ts`
Expected: FAIL — cannot resolve `./google`.

- [ ] **Step 3: Implement `effectProbes/google.ts`**

Each probe follows the same five-line skeleton; write them out in full rather than through a generic helper, because each one's *criterion* is the interesting part and a shared abstraction hides it:

```ts
const ctxForOrg = async (orgId: string): Promise<GoogleToolContext> => {
  // Same resolver the headless write path uses (googleToolsHeadless.ts:98),
  // so a probe can never read through a different connection than the write
  // wrote through. Throws GoogleConnectionUnavailableError, which
  // `probeEffect` converts to `unknown`.
  const resolved = await resolveContextByOrg(orgId);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved;
};
```

and, for example:

```ts
/**
 * `google_suspend_user` — the LAST effect of an offboarding (spec §6.3:
 * "disable/suspend is last so that a task stopped at any point leaves an
 * account that is more restricted than before").
 *
 * A 404 is `unknown`, never `satisfied`: a deleted account is not evidence
 * that the suspension we were asked to perform happened.
 */
export const probeGoogleSuspendUser: EffectProbe = async (effect, _ctx) => {
  const email = String(effect.canonicalArguments.userEmail ?? '');
  const gctx = await ctxForOrg(_ctx.orgId);
  const dir = getDirectoryClient(gctx.keyJson, gctx.conn.adminEmail);
  const res = await dir.users.get({ userKey: email });
  const suspended = res.data.suspended === true;
  return {
    state: suspended ? 'satisfied' : 'unsatisfied',
    observedAt: new Date(),
    detail: suspended
      ? `${email} is suspended in Google Workspace`
      : `${email} is NOT suspended in Google Workspace`,
  };
};
```

Register them all:

```ts
export function registerGoogleEffectProbes(): void {
  registerEffectProbe('google_suspend_user', probeGoogleSuspendUser);
  registerEffectProbe('google_remove_from_group', probeGoogleRemoveFromGroup);
  registerEffectProbe('google_remove_license', probeGoogleRemoveLicense);
  registerEffectProbe('google_set_vacation', probeGoogleSetVacation);
  registerEffectProbe('google_set_forwarding', probeGoogleSetForwarding);
  registerEffectProbe('google_add_mail_delegate', probeGoogleAddMailDelegate);
  registerEffectProbe('google_signout', probeGoogleSignout);
  registerEffectProbe('google_wipe_mobile_device', probeGoogleWipeMobileDevice);
}
```

- [ ] **Step 4: Run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectProbes/`
Expected: 2 files, all PASS (7 + 19 tests). Note the trailing slash matches only files **inside** the directory, which is what is wanted here — both files live there.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/effectProbes/google.ts apps/api/src/services/aiOperator/effectProbes/google.test.ts
git commit -m "$(cat <<'EOF'
feat(api): eight Google effect probes for probe-write-probe (E4)

Recipe Library spec §6.6. Each probe mirrors the write it verifies — same
client accessor, same impersonation, same arguments. Forwarding is satisfied
only when VERIFIED, a truncated license page is `unknown` not `satisfied`,
and google_signout is always `unknown` because Directory exposes no
session-validity field. `unknown` means handoff, never verified.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `effectDispatch.ts` — probe → write → probe

**Files:**
- Create: `apps/api/src/services/aiOperator/effectDispatch.ts`
- Create: `apps/api/src/services/aiOperator/effectDispatch.test.ts`

**This is the `effect` and `probe` step kinds' coordinator half** (spec §6.1's table: `effect` = "reserve operation → pre-write probe → mint or attach intent → dispatch via release worker"; `probe` = "run the verification adapter"). It lives in its own module so W03's coordinator edits and this wave's do not collide (D-E4-8).

**Interfaces:**
- Consumes: `probeEffect`, `type EffectProbeResult` (`./effectProbes`); `checkPlanEffectMembership`, `effectArgumentDigest` (`./planApproval`); `createActionIntent` (`../actionIntents/intentService`); `buildTaskOperationKey` (`./operationKey`); `openStep`, `markStepWaiting`, `settleStep` (`./stepService`, E2); `appendTaskEvent` (`./eventService`, E2); `getRecipe` (`./recipes`, E1); `db`, `runOutsideDbContext`, `withSystemDbAccessContext` (`../../db`).
- Produces:
  ```ts
  export type EffectDispatchOutcome =
    | { kind: 'noop'; detail: string }
    | { kind: 'dispatching'; intentId: string; detail: string }
    | { kind: 'refused'; refusal: string; detail: string }
    | { kind: 'handoff'; detail: string; handoffSummary: string };
  export async function dispatchPlannedEffect(args: {
    task: AiOperatorTaskRow; leaseEpoch: number; stepKey: string;
    effect: PlannedEffect; approverUserId: string; now?: Date;
  }): Promise<EffectDispatchOutcome>;

  export type EffectVerificationOutcome =
    | { kind: 'verified'; detail: string }
    | { kind: 'unverified'; detail: string; retryable: boolean }
    | { kind: 'handoff'; detail: string; handoffSummary: string };
  export async function verifyDispatchedEffect(args: {
    task: AiOperatorTaskRow; stepKey: string; effect: PlannedEffect;
    idempotencyClass: AiOperatorEffectIdempotencyClass;
    effectRequestedAt: Date; now?: Date;
  }): Promise<EffectVerificationOutcome>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/effectDispatch.test.ts
/**
 * probe → write → probe (Recipe Library spec §6.6).
 *
 * Three properties carry the whole design and each has a case here:
 *
 *  1. A PRE-PROBE that already observes the end state settles the operation
 *     `succeeded` with `result.noop = true` and DISPATCHES NOTHING. "Replay is
 *     a no-op by observation" is the only replay defence that exists, because
 *     neither Graph nor the Google Directory API takes an idempotency key.
 *  2. A POST-PROBE that is `unsatisfied` or `unknown` can NEVER produce
 *     `verified` (Operator spec §13). `unknown` on a `non_idempotent` effect
 *     hands off rather than retrying — a second `create user` is a second
 *     person.
 *  3. Membership is re-checked HERE too, before the intent is minted, so a
 *     plan superseded between the coordinator's read and this dispatch is
 *     refused without writing anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probeEffect = vi.fn();
const checkPlanEffectMembership = vi.fn();
const createActionIntent = vi.fn();
const settleStep = vi.fn();
const appendTaskEvent = vi.fn();

vi.mock('./effectProbes', () => ({ probeEffect }));
vi.mock('./planApproval', async (orig) => ({
  ...(await orig<typeof import('./planApproval')>()),
  checkPlanEffectMembership,
}));
vi.mock('../actionIntents/intentService', () => ({ createActionIntent }));
vi.mock('./stepService', () => ({ openStep: vi.fn(), markStepWaiting: vi.fn(), settleStep }));
vi.mock('./eventService', () => ({ appendTaskEvent }));

import { dispatchPlannedEffect, verifyDispatchedEffect } from './effectDispatch';
import type { PlannedEffect } from './recipes/types';

const task = {
  id: 't1', orgId: 'o1', revision: 2, agentId: 'a1', requesterUserId: 'u-req',
  workflowKey: 'identity_offboarding', workflowVersion: 1,
} as never;
const effect: PlannedEffect = {
  ordinal: 3, toolName: 'google_remove_from_group', provider: 'google',
  targetId: 'c1', accountExternalId: '101',
  canonicalArguments: { groupEmail: 'sales@customer.example', reason: 'offboarding', userEmail: 'dana@customer.example' },
};
const member = { ok: true, approvalId: 'p1', approverUserId: 'u-approver', idempotencyClass: 'idempotent' };

beforeEach(() => {
  vi.clearAllMocks();
  checkPlanEffectMembership.mockResolvedValue(member);
  createActionIntent.mockResolvedValue({ id: 'i1', status: 'approved' });
});

describe('dispatchPlannedEffect — the PRE probe', () => {
  it('settles succeeded with noop and dispatches NOTHING when the end state already holds', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'already not a member' });
    const out = await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    expect(out).toMatchObject({ kind: 'noop' });
    expect(createActionIntent).not.toHaveBeenCalled();
    expect(settleStep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'succeeded' }));
  });

  it('records the noop as an EVENT, so the completion record can say nothing was sent', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'already not a member' });
    await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    expect(appendTaskEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      eventType: expect.stringMatching(/effect/), detail: expect.stringContaining('already'),
    }));
  });

  it('DISPATCHES when the pre-probe says unsatisfied', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: 'still a member' });
    const out = await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    expect(out).toMatchObject({ kind: 'dispatching', intentId: 'i1' });
  });

  it('DISPATCHES when the pre-probe is unknown — an unprovable pre-state is not permission to skip', async () => {
    // Skipping on `unknown` would silently drop an effect the approver
    // authorized. Dispatching is the safe direction for an IDEMPOTENT effect.
    probeEffect.mockResolvedValue({ state: 'unknown', observedAt: new Date(), detail: 'Graph 503' });
    await expect(dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' }))
      .resolves.toMatchObject({ kind: 'dispatching' });
  });

  it('HANDS OFF instead of dispatching a NON_IDEMPOTENT effect whose pre-probe is unknown', async () => {
    // A second `create user` is a second person. If we cannot see whether it
    // already happened, a human looks.
    checkPlanEffectMembership.mockResolvedValue({ ...member, idempotencyClass: 'non_idempotent' });
    probeEffect.mockResolvedValue({ state: 'unknown', observedAt: new Date(), detail: 'Graph 503' });
    await expect(dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'create', effect, approverUserId: 'u-approver' }))
      .resolves.toMatchObject({ kind: 'handoff' });
    expect(createActionIntent).not.toHaveBeenCalled();
  });
});

describe('dispatchPlannedEffect — membership', () => {
  it('REFUSES without minting when the plan was superseded since the coordinator read it', async () => {
    checkPlanEffectMembership.mockResolvedValue({ ok: false, refusal: 'plan_superseded', detail: 'revision 3' });
    const out = await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    expect(out).toMatchObject({ kind: 'refused', refusal: 'plan_superseded' });
    expect(probeEffect).not.toHaveBeenCalled();
    expect(createActionIntent).not.toHaveBeenCalled();
  });

  it('mints with the plan context: task ctx, planApproval, the operation key and the approver', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    expect(createActionIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toolName: 'google_remove_from_group',
        source: 'mcp_api',
        task: expect.objectContaining({ taskId: 't1', taskStepKey: 'remove_groups' }),
        planApproval: { approvalId: 'p1', ordinal: 3 },
      }),
    );
  });

  it('the operation key carries the PLAN REVISION and the ORDINAL, so a new plan is a new operation', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    const key = createActionIntent.mock.calls[0]![1].task.operationKey as string;
    expect(key).toContain(':r2:');
    expect(key.endsWith(':n3')).toBe(true);
  });

  it('a duplicate dispatch reuses the SAME intent — at-most-once by operation key', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: '' });
    const a = await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    const b = await dispatchPlannedEffect({ task, leaseEpoch: 1, stepKey: 'remove_groups', effect, approverUserId: 'u-approver' });
    expect(b).toEqual(a);
  });
});

describe('verifyDispatchedEffect — the POST probe', () => {
  const requestedAt = new Date('2026-09-17T10:00:00Z');
  it('verified only on satisfied', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: 'not a member' });
    await expect(verifyDispatchedEffect({ task, stepKey: 's', effect, idempotencyClass: 'idempotent', effectRequestedAt: requestedAt }))
      .resolves.toMatchObject({ kind: 'verified' });
  });

  it('NEVER verified on unsatisfied — retryable for an idempotent effect', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: 'still a member' });
    await expect(verifyDispatchedEffect({ task, stepKey: 's', effect, idempotencyClass: 'idempotent', effectRequestedAt: requestedAt }))
      .resolves.toMatchObject({ kind: 'unverified', retryable: true });
  });

  it('NEVER retryable for a non_idempotent effect, even when unsatisfied', async () => {
    probeEffect.mockResolvedValue({ state: 'unsatisfied', observedAt: new Date(), detail: 'no user' });
    await expect(verifyDispatchedEffect({ task, stepKey: 's', effect, idempotencyClass: 'non_idempotent', effectRequestedAt: requestedAt }))
      .resolves.toMatchObject({ kind: 'unverified', retryable: false });
  });

  it('UNKNOWN hands off, with a summary naming the effect a human must check', async () => {
    probeEffect.mockResolvedValue({ state: 'unknown', observedAt: new Date(), detail: 'no probe registered' });
    const out = await verifyDispatchedEffect({ task, stepKey: 's', effect, idempotencyClass: 'idempotent', effectRequestedAt: requestedAt });
    expect(out.kind).toBe('handoff');
    expect((out as { handoffSummary: string }).handoffSummary).toContain('google_remove_from_group');
  });

  it('passes effectRequestedAt to the probe — session-style criteria compare against it', async () => {
    probeEffect.mockResolvedValue({ state: 'satisfied', observedAt: new Date(), detail: '' });
    await verifyDispatchedEffect({ task, stepKey: 's', effect, idempotencyClass: 'idempotent', effectRequestedAt: requestedAt });
    expect(probeEffect).toHaveBeenCalledWith(effect, expect.objectContaining({ effectRequestedAt: requestedAt, phase: 'post' }));
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectDispatch.test.ts`
Expected: FAIL — cannot resolve `./effectDispatch`.

- [ ] **Step 3: Implement `effectDispatch.ts`**

The order inside `dispatchPlannedEffect` is fixed and each step is there for a stated reason:

1. **Membership first, before any I/O.** A superseded plan must cost one local read, not a provider round trip.
2. **Pre-probe.** `satisfied` → settle the operation `succeeded` with `result: { noop: true, probe: <detail> }`, append an `effect_noop` event, return `{ kind: 'noop' }`. Nothing is dispatched and no intent is minted. `unknown` **and** `idempotencyClass === 'non_idempotent'` → `{ kind: 'handoff' }`. Otherwise fall through.
3. **Build the operation key** with `buildTaskOperationKey({ taskStepKey: stepKey, planRevision: task.revision, toolName: effect.toolName, targetId: effect.targetId, ordinal: effect.ordinal })` — `operationKey.ts:52`, format `step:tool:target:r<rev>:n<ordinal>`. The plan revision being in the key is what makes a re-approved plan a **new** operation rather than a replay of the old one.
4. **Mint** via `createActionIntent(approverAuth, { toolName, input: effect.canonicalArguments, source: 'mcp_api', task: { taskId, taskStepKey: stepKey, operationKey, attemptOrdinal: task.attemptOrdinal }, planApproval: { approvalId, ordinal } })`. `createActionIntent` reserves the operation in the same transaction (`intentService.ts:2110-2132`), so at-most-once comes from `ai_operator_operations_org_task_op_uq` and needs no code here.
5. `markStepWaiting(..., { dependencyKind: 'intent', dependencyId: intentId })` and return `{ kind: 'dispatching' }`.

`approverAuth` is built by `buildAuthContextForUser(orgId, approverUserId)` — run `grep -n "export async function build" apps/api/src/services/actionIntents/actorContext.ts` and use the exported builder that takes a user id and an org id. **Do not construct an `AuthContext` literal**: the release path rebuilds it from scratch anyway, and a hand-built one here would диverge from what release sees. If no such builder is exported, export a thin one from `actorContext.ts` rather than inlining a second rebuild.

`verifyDispatchedEffect` is a pure classifier over one `probeEffect` call:

```ts
  switch (probe.state) {
    case 'satisfied':
      return { kind: 'verified', detail: probe.detail };
    case 'unsatisfied':
      // Never `verified`. Operator spec §13: "Failed/inconclusive
      // verification cannot produce 'Resolved'." Retry is permitted only for
      // an effect the recipe classified as safe to re-send.
      return { kind: 'unverified', detail: probe.detail, retryable: idempotencyClass !== 'non_idempotent' };
    case 'unknown':
    default:
      // Spec §6.6: "unknown effect → handoff". We do not know whether the
      // provider applied it, so neither retrying nor declaring success is
      // honest. A human looks.
      return {
        kind: 'handoff',
        detail: probe.detail,
        handoffSummary:
          `Breeze could not confirm the result of ${effect.toolName} on ${effect.accountExternalId ?? effect.targetId ?? 'the target'}. `
          + 'It may or may not have been applied. Check the provider before retrying.',
      };
  }
```

- [ ] **Step 4: Run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/effectDispatch.test.ts`
Expected: PASS — 1 file, 15 tests.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/effectDispatch.ts apps/api/src/services/aiOperator/effectDispatch.test.ts
git commit -m "$(cat <<'EOF'
feat(api): probe-write-probe dispatch for plan-approved effects (E4)

Recipe Library spec §6.1 (effect/probe step kinds) and §6.6. A satisfied
pre-probe settles the operation succeeded with noop and dispatches nothing —
replay is a no-op by observation, the only defence available when no
provider takes an idempotency key. Post-probe unsatisfied/unknown can never
be verified, and non_idempotent effects are never auto-retried.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Coordinator wiring — exactly four added lines

**Files:**
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts`
- Create: `apps/api/src/services/aiOperator/taskCoordinator.planApproval.test.ts`

**W03 is editing this file in parallel (D-E4-8).** This task adds **two imports and two `case` arms** and nothing else. It does not touch the three invariants at `:7-40`, does not edit `writeLeased` / `yieldToWait` / `settle` / `writeLeasedStep` / `admitReasoningRun`, and does not rename `admitReasoningRun`'s `bumpPlanRevision` boolean. If a merge conflict appears in any other hunk, the conflict is W03's change and this wave's side is "take theirs".

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiOperator/taskCoordinator.planApproval.test.ts
/**
 * The coordinator's two new step kinds (E4), tested at the seam only.
 *
 * The behaviour lives in planApproval.ts and effectDispatch.ts and is tested
 * there; what is asserted HERE is that `advanceTask` routes to them, that a
 * refusal SETTLES rather than throwing (a throw would leave the BullMQ wake
 * job retrying forever against a row that can never advance — the same rule
 * E1's unknown-recipe branch follows), and that the three coordinator
 * invariants are still stated verbatim at the top of the file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('coordinator invariants are untouched by E4', () => {
  const src = readFileSync(join(__dirname, 'taskCoordinator.ts'), 'utf8');
  it('still states all three invariants, verbatim', () => {
    expect(src).toContain('IT HOLDS NOTHING WHILE WAITING');
    expect(src).toContain('IT NEVER TRUSTS THE WAKE PAYLOAD');
    expect(src).toContain('`revision` IS THE PLAN REVISION, NOT A CAS COUNTER');
  });
  it('adds no new writer of `revision` — bumping stays in admitReasoningRun and planApproval.ts', () => {
    const bumps = src.match(/revision:\s*nextRevision|revision:\s*task\.revision\s*\+\s*1/g) ?? [];
    expect(bumps.length).toBe(1);
  });
  it('keeps step execution OUT of recipes: the new arms call effectDispatch, not a recipe method', () => {
    expect(src).toContain("from './effectDispatch'");
    expect(src).not.toMatch(/recipe\.(dispatch|execute|probe)\(/);
  });
});

describe('advanceTask routing (E4)', () => {
  it('routes a plan_approval step to the plan-approval advancer', async () => { /* … */ });
  it('routes an effect step to the effect advancer', async () => { /* … */ });
  it('SETTLES (never throws) when membership refuses', async () => { /* … */ });
});
```

> The three routing cases follow whatever mocking style `taskCoordinator.recipeResolution.test.ts` (E1) established. **Read that file first and reuse it**; do not introduce a second coordinator test harness.

- [ ] **Step 2: Run it red**

Run: `cd apps/api && npx vitest run src/services/aiOperator/taskCoordinator.planApproval.test.ts`
Expected: FAIL — `taskCoordinator.ts` contains no `from './effectDispatch'`.

- [ ] **Step 3: The four lines**

Two imports, beside the existing `./operationKey` import:

```ts
import { advancePlanApprovalStep } from './planApproval';
import { advanceEffectStep } from './effectDispatch';
```

Two arms in the `switch (stepKey)` at `:435-448` — but the switch is keyed on a **step KEY**, not a step kind, so route on the recipe's declared kind instead. Replace the `default:` arm's body with a kind lookup that falls back to the existing settle:

```ts
    default: {
      // E4 — the two kind-dispatched step families. E1's registry owns which
      // kind a step key is (`recipe.steps[k].kind`); the coordinator owns HOW
      // each kind runs (spec §6.1's step-kind table: "Step execution by kind
      // is coordinator code, not recipe code"). Both advancers settle their
      // own refusals and never throw — a throw here would leave the BullMQ
      // wake job retrying forever against a row that can never advance.
      const kind = resolveStepKind(task.workflowKey, task.workflowVersion, stepKey);
      if (kind === 'effect') return advanceEffectStep(task, leaseEpoch, checkpoint, stepKey);
      if (kind === 'probe' && stepKey.startsWith('plan_')) {
        return advancePlanApprovalStep(task, leaseEpoch, checkpoint, stepKey);
      }
      await settle({
        task, leaseEpoch, event: 'fail', outcome: 'unresolved',
        detail: `unknown step '${stepKey}'`, checkpoint,
      });
      return `failed: unknown step ${stepKey}`;
    }
```

> **If E1 named the plan step something other than a `plan_` prefix**, route on the recipe's own step definition rather than a string prefix: `recipe.steps[stepKey]?.kind === 'effect'` and a dedicated `plan_approval` kind if E1 added one. Run `grep -n "plan_approval\|STEP_KINDS" apps/api/src/services/aiOperator/recipes/types.ts` before writing this and follow what is actually there. **Do not add a new value to `STEP_KINDS`** — that array is pinned by E1's `types.test.ts` and by E2's `ai_operator_task_steps.step_kind` CHECK, and widening it here would red both.

`advancePlanApprovalStep` and `advanceEffectStep` live in the two new modules and take the coordinator's own primitives as arguments rather than importing them (which would be a cycle). Export the three private writers the advancers need through the existing `__testOnly` seam pattern W02 established (`export const __testOnly = { writeLeasedStep, yieldToWait, settle }`, W02 Task 10) — or, cleaner and preferred: have the advancers **return** a typed intent (`{ action: 'wait', … } | { action: 'settle', … } | { action: 'step', … }`) and let the coordinator's arm perform the write. That keeps every write to `ai_operator_tasks` inside `taskCoordinator.ts`, which is invariant 1's actual guarantee, and it keeps the two new modules pure enough to unit-test without a database. **Take the second option** and adjust Task 11's `EffectDispatchOutcome` consumers accordingly.

- [ ] **Step 4: Run green**

Run: `cd apps/api && npx vitest run src/services/aiOperator/ && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: every `aiOperator` unit file passes (check the count — E1 and E2's files must still be there), and `tsc` is clean.

Then prove the blast radius is four lines:

Run: `git diff --stat -- apps/api/src/services/aiOperator/taskCoordinator.ts`
Expected: roughly `1 file changed, ~14 insertions(+), ~4 deletions(-)`. If it is materially larger, work moved into the coordinator that belongs in the two new modules — move it back.

- [ ] **Step 5: Commit**

```
git add apps/api/src/services/aiOperator/taskCoordinator.ts apps/api/src/services/aiOperator/taskCoordinator.planApproval.test.ts
git commit -m "$(cat <<'EOF'
feat(api): route effect and plan-approval steps from the coordinator (E4)

Two imports and one switch arm. Step EXECUTION stays coordinator code (spec
§6.1) but lives in effectDispatch.ts / planApproval.ts so W03's parallel
coordinator work does not collide. Advancers RETURN a typed intent; every
write to ai_operator_tasks stays inside taskCoordinator.ts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Adversarial integration suites — the acceptance gate

**Files:**
- Create: `apps/api/src/__tests__/integration/aiOperatorPlanApprovalRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiOperatorPlanApprovalMembership.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/aiOperatorEffectDispatchReplay.integration.test.ts`

**These three files are what the wave is judged on.** Everything above can pass with a stub; none of the properties below can. All three live under `src/__tests__/integration/` — a wrongly placed integration test runs **zero** tests and reads green.

Prerequisite: `pnpm test-stack up` (from Task 3 Step 7) and the migration applied.

- [ ] **Step 1: `aiOperatorPlanApprovalRls.integration.test.ts` — tenancy, as `breeze_app`**

```ts
/**
 * Tenant isolation for the plan-approval tables, proved against real Postgres
 * as the UNPRIVILEGED `breeze_app` role.
 *
 * Why as breeze_app and not through the ORM under a system context: Shape-1
 * RLS binds the table OWNER only because the tables are FORCE ROW LEVEL
 * SECURITY, and a test that runs as the owner with `breeze.scope = system`
 * proves nothing about what the API's actual connection can do. A forged
 * cross-tenant INSERT must be REFUSED (42501 / "new row violates row-level
 * security policy"), not merely filtered — CLAUDE.md's verification step.
 */
describe('ai_operator_plan_approvals tenancy', () => {
  it('a cross-org INSERT is refused with a row-level security violation', async () => { /* … */ });
  it('a cross-org SELECT returns zero rows, not another tenant\'s plan', async () => { /* … */ });
  it('an effect row can never name an approval belonging to a DIFFERENT TASK', async () => {
    // The composite FK (approval_id, task_id, org_id) is the structural
    // guarantee. RLS alone checks only org_id and would not catch a
    // same-org, wrong-task reference — which is how one org's offboarding
    // plan could authorize an effect on another of its own tasks.
    // Expect 23503.
  });
  it('an effect row can never name an approval in another ORG (same FK, org leg)', async () => { /* 23503 */ });
  it('two plans at the SAME (task, revision) are refused by the unique index', async () => { /* 23505 */ });
  it('an approved row without an approver is refused by the CHECK', async () => { /* 23514 */ });
  it('a superseded row without superseded_by_revision is refused by the CHECK', async () => { /* 23514 */ });
  it('an effect row is IMMUTABLE: any UPDATE raises, even as the table owner', async () => {
    // REVOKE UPDATE covers breeze_app; the trigger covers everyone else,
    // including a migration or a restore that re-grants.
  });
  it('a breeze-provider effect with an account_external_id is refused', async () => { /* 23514 */ });
  it('deleting the task CASCADES both tables away', async () => { /* org erasure path */ });
});
```

- [ ] **Step 2: `aiOperatorPlanApprovalMembership.integration.test.ts` — the nine adversarial cases**

Each case seeds a real task, a real approval, real effect rows and a real intent, then calls the **production** path (`createActionIntent` for the mint check, `revalidateApprovedIntentForRelease` for the release check) — never the predicate in isolation, because the thing being proved is that the production path consults it.

```ts
describe('plan-approval membership (adversarial)', () => {
  it('an effect NOT IN THE SET is refused at mint and at release', async () => {
    // Ordinal 9 on a 3-effect plan. Both entry points must refuse; a wave that
    // only guarded one would ship a bypass reachable from the other.
  });

  it('the SAME ORDINAL with a DIFFERENT argument digest is refused', async () => {
    // The §7.1 property, stated as an attack: the approver signed
    // "remove dana from sales"; the dispatch says "remove dana from finance"
    // at the same slot. Same task, same revision, same ordinal, same tool.
  });

  it('an approval belonging to ANOTHER TASK cannot authorize this task\'s effect', async () => {
    // Two tasks in the SAME org, each with an approved plan. Task B's
    // approvalId + Task A's taskId must refuse — RLS cannot see this one,
    // only the (task_id, plan_revision, ordinal) key and the composite FK can.
  });

  it('an approval belonging to another ORG is invisible and refuses', async () => {
    // Under org A's RLS context, org B's approval id reads as missing —
    // `plan_approval_missing`, never a cross-tenant admit.
  });

  it('a SUPERSEDED approval refuses, and bumpPlanRevision is what supersedes it', async () => {
    // Approve at revision 2, call bumpPlanRevision, then attempt to release a
    // child effect minted before the bump. Assert: approval.state ===
    // 'superseded', superseded_by_revision === 3, the release returns
    // plan_approval_revoked, and the UNDISPATCHED child intent is cancelled
    // with error_code 'plan_superseded'.
  });

  it('bumpPlanRevision does NOT cancel an intent whose operation is already dispatched', async () => {
    // A dispatched effect is a real-world change. Cancelling its intent would
    // destroy the record without undoing the effect.
  });

  it('an EXPIRED plan intent refuses', async () => {
    // Backdate approval_expires_at past now and attempt release.
  });

  it('the REQUESTER cannot approve their own plan', async () => {
    // Mint operator_plan as the task's requester; assert the four-eyes fan-out
    // contains NO approval_requests row for them, and that a decide attempt by
    // that user is refused. Inherited unchanged from action intents — this
    // test proves the inheritance, which is the only thing a new approval
    // primitive can get wrong silently.
  });

  it('a SOLE OPERATOR can self-approve only with assurance level 3', async () => {
    // One eligible approver who IS the requester: exactly one approval_requests
    // row is created for them, a decide at level < 3 returns 403
    // step_up_required, and a decide at level 3 succeeds. Also inherited.
  });

  it('a tool OUTSIDE the admitting agent\'s frozen allowlist is refused at mint AND at release', async () => {
    // Mint with the tool allowed, then NARROW the agent policy, then release.
    // Assert errorCode 'tool_not_in_agent_allowlist' at release — the
    // mint-time check alone cannot deliver revocation.
  });

  it('a SECRET-BEARING effect cannot ride a plan', async () => {
    // google_reset_password with a valid-looking planApproval must be refused
    // with plan_approval_invalid, and no ai_operator_operations row is written.
  });

  it('the plan intent carries a NON-NULL effect_digest pinned to the effect ROWS', async () => {
    // Task 5's resolver. Then mutate an effect row through a superuser
    // connection (the app cannot) and assert the release fails digest_mismatch
    // BEFORE the membership check reports anything.
  });
});
```

- [ ] **Step 3: `aiOperatorEffectDispatchReplay.integration.test.ts` — at-most-once across a crash**

```ts
describe('effect dispatch replay', () => {
  it('replay after a worker crash dispatches each effect AT MOST ONCE', async () => {
    // Dispatch all three effects of a plan; simulate a crash by re-running the
    // coordinator arm for the same (task, revision, ordinal) set; assert
    // exactly three ai_operator_operations rows, each with one intent id, and
    // that reserveOperation's second call returned the SAME intent rather than
    // throwing OperationReplayError (the same-intent redelivery branch,
    // operationService.ts:120-134).
  });

  it('a DIFFERENT intent claiming an already-reserved operation raises OperationReplayError', async () => {
    // The sequential-replay guard. This is the case that would otherwise
    // double-remove a license.
  });

  it('a pre-probe that observes the end state writes NO intent and settles noop', async () => {
    // Against a stubbed probe registry but a REAL database: assert the
    // operation row exists with result_state 'succeeded' and result.noop true,
    // and that action_intents has no row for that operation key.
  });

  it('a new plan revision creates a NEW operation key, so re-approval is not a replay', async () => {
    // r2:n0 and r3:n0 are different operations. Without the revision in the
    // key, a re-approved plan's first effect would collide with the old one's
    // and be silently skipped.
  });
});
```

- [ ] **Step 4: Run all three**

Run:
```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiOperatorPlanApprovalRls.integration.test.ts \
  src/__tests__/integration/aiOperatorPlanApprovalMembership.integration.test.ts \
  src/__tests__/integration/aiOperatorEffectDispatchReplay.integration.test.ts
```
Expected: 3 files, ~26 tests, all PASS. **Read the reported counts** — a 0-test run means the files landed outside `src/__tests__/integration/` and is a stall, not a pass.

- [ ] **Step 5: Commit**

```
git add apps/api/src/__tests__/integration/aiOperatorPlanApproval*.integration.test.ts apps/api/src/__tests__/integration/aiOperatorEffectDispatchReplay.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): adversarial integration suites for plan approval (E4)

Recipe Library spec §11 "Plan approval becomes a four-eyes bypass", as
executable cases: effect not in set, same ordinal different digest, another
task's approval, another org's approval, superseded, expired, requester
self-approval, sole-operator step-up, allowlist at mint AND release,
secret-bearing refused, crash replay at-most-once. Real Postgres; the RLS
cases run as breeze_app.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Web — the plan approval card, MOUNTED

**Files:**
- Create: `apps/web/src/components/approvals/OperatorPlanApprovalCard.tsx`
- Create: `apps/web/src/components/approvals/OperatorPlanApprovalCard.test.tsx`
- Modify: `apps/web/src/components/approvals/ApprovalsInbox.tsx`
- Modify: `apps/web/src/components/approvals/ApprovalsInbox.test.tsx` (append one mount case)

**A previous wave shipped 13 green components that were never wired into a page.** Step 4 of this task is the mount and it is not optional; Step 5's assertion is that the card renders **from `ApprovalsInbox`**, not in isolation.

The card needs **no fetch**: the effect rendering is inside `approval.actionArguments.effects`, bounded to 64 lines of ≤500 chars by the table CHECKs. That is deliberate — an approver must be able to read what they are signing without a second request that could fail or return something different.

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/web/src/components/approvals/OperatorPlanApprovalCard.test.tsx
/**
 * The plan approval card (Recipe Library spec §6.4: "The approval card shows
 * the full list, per provider, with the target's frozen labels").
 *
 * The properties under test are all about what an approver can SEE before
 * clicking approve, because this one click authorizes up to 64 destructive
 * effects across two providers. A card that summarised ("9 effects") would
 * make the plan approval exactly the four-eyes bypass §11 warns about.
 *
 * Queries are data-testid only, per e2e-tests/README.md's convention.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import OperatorPlanApprovalCard from './OperatorPlanApprovalCard';

const args = {
  taskId: '00000000-0000-4000-8000-0000000000a1',
  planRevision: 2,
  effectSetDigest: 'a'.repeat(64),
  effects: [
    { ordinal: 0, provider: 'm365', toolName: 'm365_set_auto_reply', targetLabel: 'Dana Ruiz', principalLabel: 'dana@customer.example', rendering: 'Set an auto-reply on Dana\'s M365 mailbox' },
    { ordinal: 1, provider: 'google', toolName: 'google_set_forwarding', targetLabel: 'Dana Ruiz', principalLabel: 'dana@customer.example', rendering: 'Forward Dana\'s Gmail to manager@customer.example' },
    { ordinal: 2, provider: 'google', toolName: 'google_suspend_user', targetLabel: 'Dana Ruiz', principalLabel: 'dana@customer.example', rendering: 'Suspend Dana\'s Google Workspace account' },
  ],
};

describe('OperatorPlanApprovalCard', () => {
  it('renders EVERY effect — no truncation, no "and 6 more"', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(screen.getAllByTestId(/^operator-plan-effect-/)).toHaveLength(3);
  });

  it('groups by provider and labels each group', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(within(screen.getByTestId('operator-plan-group-m365')).getAllByTestId(/^operator-plan-effect-/)).toHaveLength(1);
    expect(within(screen.getByTestId('operator-plan-group-google')).getAllByTestId(/^operator-plan-effect-/)).toHaveLength(2);
  });

  it('shows the FROZEN target and principal labels, not a re-resolved name', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(screen.getByTestId('operator-plan-effect-2')).toHaveTextContent('dana@customer.example');
  });

  it('preserves DISPATCH ORDER inside a group and shows the ordinal', () => {
    // §6.3's ordering is a safety contract: suspend is last so a stopped task
    // never leaves a disabled account with mail unrouted. An approver who
    // cannot see the order cannot review it.
    render(<OperatorPlanApprovalCard args={args} />);
    const rows = screen.getAllByTestId(/^operator-plan-effect-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'operator-plan-effect-0', 'operator-plan-effect-1', 'operator-plan-effect-2',
    ]);
  });

  it('shows the plan revision and the effect count', () => {
    render(<OperatorPlanApprovalCard args={args} />);
    expect(screen.getByTestId('operator-plan-summary')).toHaveTextContent('2');
    expect(screen.getByTestId('operator-plan-summary')).toHaveTextContent('3');
  });

  it('renders an explicit empty state rather than an empty list', () => {
    render(<OperatorPlanApprovalCard args={{ ...args, effects: [] }} />);
    expect(screen.getByTestId('operator-plan-empty')).toBeInTheDocument();
  });

  it('escapes rendering text — it is server-supplied and must never be HTML', () => {
    render(<OperatorPlanApprovalCard args={{
      ...args, effects: [{ ...args.effects[0]!, rendering: '<img src=x onerror=alert(1)>' }],
    }} />);
    expect(screen.getByTestId('operator-plan-effect-0')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `cd apps/web && npx vitest run src/components/approvals/OperatorPlanApprovalCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the card**

Plain presentational component, `useTranslation('approvals')`, no fetch, no mutation (approve/deny stay on the inbox's existing buttons and therefore already go through its `runAction` wrapper — **do not add a second mutation path here**). Group with a stable provider order `['breeze', 'm365', 'google']` so two renders of the same plan never differ. Every string through `t(...)`; no literal copy.

- [ ] **Step 4: MOUNT it in `ApprovalsInbox.tsx`**

Mirror the `proposalId` pattern at `:1005-1010` and `:1087-1110`:

```tsx
    const operatorPlan =
      approval.actionToolName === 'operator_plan' && approval.actionArguments
        ? (approval.actionArguments as OperatorPlanArgs)
        : null;
```

and, in the card body beside the script-proposal block:

```tsx
            {operatorPlan && (
              <div className="mt-3" data-testid={`approval-operator-plan-${approval.id}`}>
                {/* Rendered INLINE, not behind a toggle like the script
                    proposal: the script card fetches a body, this one is
                    already in the arguments, and an approver must not be able
                    to approve a nine-effect identity plan without the list
                    being on screen. */}
                <OperatorPlanApprovalCard args={operatorPlan} />
              </div>
            )}
```

- [ ] **Step 5: Prove the mount** (append to `ApprovalsInbox.test.tsx`)

```tsx
  it('renders the operator plan card INSIDE the inbox for an operator_plan approval', async () => {
    // The mount assertion. A previous wave shipped 13 green components that
    // were never wired into a page; a card that only its own suite renders is
    // not shipped.
    renderInboxWith([{ ...pendingApproval, actionToolName: 'operator_plan', actionArguments: PLAN_ARGS }]);
    expect(await screen.findByTestId(`approval-operator-plan-${pendingApproval.id}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^operator-plan-effect-/)).toHaveLength(3);
  });

  it('does NOT render it for any other tool', () => {
    renderInboxWith([{ ...pendingApproval, actionToolName: 'run_script' }]);
    expect(screen.queryByTestId(/^approval-operator-plan-/)).toBeNull();
  });
```

- [ ] **Step 6: Run green**

Run: `cd apps/web && npx vitest run src/components/approvals/ && npx astro check`
Expected: all approvals suites pass (check the file count — `ApprovalsInbox.test.tsx`'s pre-existing cases must still be there), `astro check` reports 0 errors.

- [ ] **Step 7: Commit**

```
git add apps/web/src/components/approvals/
git commit -m "$(cat <<'EOF'
feat(web): operator plan approval card, mounted in the approvals inbox (E4)

Recipe Library spec §6.4. Every effect is rendered, grouped by provider, in
dispatch order, with the FROZEN target and principal labels — no truncation
and no toggle, because one click here authorizes up to 64 destructive
effects. Mount asserted from ApprovalsInbox, not only in isolation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: i18n — real translations in every locale

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/approvals.json`

Eight locale files, one new `operatorPlan` block each. **Real translations, not English copied into seven files** — the locale-parity coverage test treats an untranslated value as a missing key, and a half-translated approval card is worse than an English one because the approver stops reading.

- [ ] **Step 1: Add the `en` block, then translate**

```jsonc
"operatorPlan": {
  "title": "Plan for AI Operator task",
  "summary": "{{count}} effects, plan revision {{revision}}",
  "groupBreeze": "Breeze devices",
  "groupM365": "Microsoft 365",
  "groupGoogle": "Google Workspace",
  "effectOrdinal": "Step {{ordinal}}",
  "targetLine": "{{targetLabel}} ({{principalLabel}})",
  "orderNote": "Effects run in this order. Sign-in is disabled last, so stopping early never leaves mail unrouted.",
  "empty": "This plan contains no effects."
}
```

- [ ] **Step 2: Run the parity test**

Run: `cd apps/web && npx vitest run src/locales/`
Expected: PASS. If the repo's locale test lives elsewhere, run `grep -rln "locale" apps/web/src --include=*.test.ts | head` and run that file.

- [ ] **Step 3: Commit**

```
git add apps/web/src/locales/
git commit -m "$(cat <<'EOF'
i18n(web): operator plan approval card strings in all eight locales (E4)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Mobile — the plan on the approval detail screen

**Files:**
- Modify: `apps/mobile/src/services/approvals.ts`
- Modify: the approval detail screen (find it: `grep -rln "actionArguments\|riskSummary" apps/mobile/src | head`)

Mobile approvals are generic and data-driven: `ApprovalRequest` already carries `actionLabel`, `actionToolName`, `actionArguments`, `riskTier`, `riskSummary` (`apps/mobile/src/services/approvals.ts:17-54`). Nothing server-side needs changing.

- [ ] **Step 1: Type the arguments and render the list**

Add an exported `OperatorPlanArguments` interface beside `ApprovalRequest`, a type guard `isOperatorPlanApproval(a: ApprovalRequest)`, and — on the detail screen only — a grouped, ordered effect list mirroring the web card. **The same "no truncation" rule applies**: a phone approving nine identity effects must scroll, not summarise.

Also refresh the doc comment at `:34-41` (it names `m365_reset_password` / `m365_disable_user` as the tools that populate `customerTenant`); `operator_plan` does **not** populate it, and saying so prevents a later author wiring it into `M365_MUTATION_TOOLS` (`routes/approvals.ts:1484`), which would be wrong — a plan is provider-neutral and may name two tenants at once.

- [ ] **Step 2: Test and commit**

Run the mobile suite as the repo defines it (`grep -n '"test"' apps/mobile/package.json`), then:

```
git add apps/mobile/src
git commit -m "$(cat <<'EOF'
feat(mobile): render the full effect list on an operator_plan approval (E4)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Full verification, follow-ups, and the PR

- [ ] **Step 1: Typecheck and the full unit suites**

```
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/api && npx vitest run
cd apps/web && npx vitest run && npx astro check
cd packages/shared && npx vitest run
```
All green. **Read the file/test counts** on each.

- [ ] **Step 2: The contract suites — tenancy was touched, so all of them**

```
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts
```
All six must pass. `orgLifecycleFoundations`'s "merge contract" is the one that catches a non-deferrable composite FK; it only runs here, never in the unit job, so a unit-green branch can still redden main.

- [ ] **Step 3: Migration guards**

```
bash scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
`migrationRlsScope.test.ts` must pass **without** the new file being added to its frozen 122-offender baseline. If it demands an entry, the migration writes rows somewhere — find the write and either remove it or elect `breeze.scope` as its first statement.

- [ ] **Step 4: Placeholder and drift scan**

```
grep -rn "PASTE_FROM_STEP_6\|TODO\|FIXME" packages/shared/src/canonicalize apps/api/src/services/aiOperator apps/api/src/services/aiToolsAiOperator.ts
cd apps/api && pnpm db:check-drift
```
Expected: no hits, no drift.

- [ ] **Step 5: Tear the stack down**

```
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Nothing from this worktree may be left running. Report in the PR body what, if anything, remains.

- [ ] **Step 6: File the two follow-ups**

1. **`google_signout` has no verification probe** — Directory exposes no session-validity field, so an offboarding including it can never reach `verified_resolved` (D-E4-7). Body: what was checked (`users.get` fields, `lastLoginTime` rejected as a proxy), the M365 precedent (W05's `reset_password`), and the ask (a Google API that exposes session validity, or an accepted downgrade to `partial` for this effect). Label `enhancement`.
2. **Plan-approval expiry has no reaper** — `state = 'expired'` is refused by the membership check but nothing writes it; today an expired plan is caught by the intent's own `approval_expires_at` and surfaces as `plan_approval_missing`/`digest_mismatch` rather than a clean `plan_expired`. Body: the exact refusal a user sees today and the ask (extend the existing intent reaper to stamp the approval row). Label `enhancement`.

- [ ] **Step 7: Open the PR and STOP**

```
gh pr create --repo LanternOps/breeze --base main \
  --title "feat(ai-operator): plan approval — one four-eyes decision over a digest-pinned effect set (E4)" \
  --body "$(cat <<'EOF'
Closes #<wave sub-issue>

## What

Wave E4 of the Operator Recipe Library. One four-eyes decision authorizes an ordered, digest-pinned SET of provider effects instead of up to eighteen, and every effect is dispatched probe → write → probe.

- `ai_operator_plan_approvals` + `ai_operator_plan_approval_effects` (Shape 1, forced RLS, `text`+CHECK, deferrable composite FKs). The approved set is **child rows**, and effect rows are immutable (REVOKE UPDATE + trigger).
- `effect_set_digest` over the **same canonicalizer** `action_intents.argument_digest` uses, with frozen cross-implementation vectors.
- `operator_plan` — Tier 3, four-eyes, registered everywhere `m365_disable_user` is, **executing nothing**: its release marks the plan approved and wakes the task. It is the only four-eyes surface with a real `EFFECT_DIGEST_RESOLVERS` entry, because everything it references is a local row.
- Release-time membership: an effect is dispatched only if `(task_id, plan_revision, ordinal, argument_digest)` is in the approved set **read from rows**, the approval is `approved` and not superseded/expired, the task's `revision` still matches, and the tool is in the admitting agent's **frozen** allowlist — checked at mint **and** at release, because a check in one place cannot revoke.
- `bumpPlanRevision` supersedes the prior approval and cancels **undispatched** child intents only; a dispatched effect's record survives.
- Secret-bearing effects are split out of the plan and keep their individual intent.
- Provider-neutral `EffectProbe` registry; eight Google probes. Unregistered, throwing and slow probes all answer `unknown`, and `unknown` can never produce `verified`.

## Security posture

Inherited unchanged and proved by test, not assumed: expiry, requester-cannot-self-approve, sole-operator step-up self-approval at assurance level 3.

Three adversarial integration suites (real Postgres; RLS cases as `breeze_app`) cover: effect not in set, same ordinal with a different argument digest, another task's approval, another org's approval, superseded, expired, requester self-approval, sole-operator step-up, allowlist at mint and at release, secret-bearing refused, and crash replay dispatching each effect at most once.

## Decisions worth a reviewer's attention

See the plan's `D-E4-1` … `D-E4-8`. The one to look hardest at is **D-E4-2**: `task` context becomes legal for a non-agent principal when — and only when — a row-backed plan-membership proof accompanies it, substituting for the agent run-linkage proof. It is modelled on the shipped `script_reviewer` lane's release-time evidence substitution.

## Verification

API `tsc` clean; API, web and shared unit suites green; six tenancy/erasure contract suites green on a real stack; migration naming and RLS-scope guards green; `db:check-drift` clean. Test stack torn down.

## Follow-ups filed

- `google_signout` has no verification probe (Directory exposes no session-validity field).
- Plan-approval expiry has no reaper; expiry surfaces through the intent's own deadline today.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Then STOP.** Do not merge, do not `--admin`. The reviewed, green PR is the deliverable.

---

## Self-review

### Spec coverage

| Spec § | Covered by |
|---|---|
| §5.4 `ai_operator_plan_approvals` (+ the columns the real design needs) | Task 3 |
| §5 preamble — Shape 1, forced RLS, `text`+CHECK, deferrable composite FKs, registration in the same PR | Tasks 3, 4 |
| §6.4 — `PlannedEffect` ordering, `effect_set_digest` over the same canonicalizer | Task 2 |
| §6.4 — one `operator_plan` intent, Tier 3, four-eyes, immutable arguments, card shows the full list with frozen labels | Tasks 5, 14, 16 |
| §6.4 — release-time membership from rows, after the usual revalidation | Tasks 6, 8 |
| §6.4 — any change bumps `revision`, supersedes, requires a new approval | Task 6 (`bumpPlanRevision`), Task 13 |
| §6.4 — expiry / requester-cannot-self-approve / sole-operator step-up inherited unchanged | Task 13 (proved, not assumed) |
| §6.4 — secret-bearing effects excluded and split | Tasks 6, 7, 13 |
| §6.4 — per-effect operation, event and audit attributed to the plan's approver | Tasks 7, 11 |
| §6.4 closing line — ceiling at `createActionIntent` | Task 7 (+ Task 8's release twin), D-E4-5 |
| §6.6 — probe → write → probe; pre-probe satisfied ⇒ noop; post-probe unsatisfied/unknown ⇒ never verified; `non_idempotent` never auto-retried; unknown ⇒ handoff | Tasks 9, 10, 11 |
| §6.1 step-kind table rows `effect` and `probe` — execution is coordinator code | Tasks 11, 12 |
| §11 risk "Plan approval becomes a four-eyes bypass" | Task 13, end to end |
| §10 row E4 | the wave |

### Placeholder scan

The only intentional placeholder is `PASTE_FROM_STEP_6` in Task 2's vectors, removed by Task 2 Step 6 and asserted absent by Task 2 Step 7's test and again by Task 17 Step 4. No `TBD`, no "similar to", no "add validation".

### Identifier consistency

`computeEffectSetDigest` / `canonicalizeEffectSet` / `PlannedEffectForDigest` (Task 2) are consumed in Tasks 5, 6. `aiOperatorPlanApprovals` / `aiOperatorPlanApprovalEffects` (Task 3) in Tasks 4, 5, 6, 13. `checkPlanEffectMembership` / `loadTaskAgentToolAllowlist` / `bumpPlanRevision` / `splitSecretBearingEffects` / `effectArgumentDigest` (Task 6) in Tasks 7, 8, 11, 13. `planApproval` input and the `plan_approval_revoked` / `tool_not_in_agent_allowlist` error codes (Tasks 7, 8) in Task 13. `EffectProbe` / `probeEffect` / `registerEffectProbe` (Task 9) in Tasks 10, 11. `dispatchPlannedEffect` / `verifyDispatchedEffect` (Task 11) in Task 12. `planOrdinalFromOperationKey` is added to `operationKey.ts` in Task 8 and is the single parser of the key format `buildTaskOperationKey` writes.

Consumed from earlier waves and never redefined: `PlannedEffect`, `getRecipe`, `RecipeDefinition`, `STEP_KINDS` (E1); `openStep`, `markStepWaiting`, `settleStep`, `resolveStepKind`, `appendTaskEvent`, `aiOperatorTaskSteps`, `aiOperatorTaskEvents`, `aiOperatorTaskTargets` (E2); `probeM365Effect`, `M365_HEADLESS_ACTIONS` (M1/W05, adapted, optional).
