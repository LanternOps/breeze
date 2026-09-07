---
title: AI Operator P3-0a, adapter contracts, recipe cards, terminal-writer inventory, legacy-trigger sunset list
date: 2026-09-07
status: P3-0a deliverable for LanternOps/breeze#5205 (wave #5206)
spec: docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md
plan: docs/superpowers/plans/ai-mcp/2026-09-07-ai-operator-completion.md
spec_plan_note: Both land with PR #5204, which was still unmerged when this wave ran. The paths resolve once #5204 reaches main.
baseline_commit: 89b059f12ff82a13aa930a13ddee25bb14c03c69
---

# AI Operator P3-0a baseline and contracts

This document is the P3-0 "Baseline and contracts" deliverable, PR (1). It records what the
repository actually does today, so P3-1 is designed against code rather than against the spec's
description of code. Fixtures and the EXPLAIN harness are wave W02 and are not in scope here.

**Evidence labels.** Every claim about code carries a `file:line` citation at
`89b059f12ff82a13aa930a13ddee25bb14c03c69` and one of three labels:

- **VERIFIED**, the cited lines were read.
- **INFERRED**, reasoned from adjacent code that was read; the conclusion itself was not observed.
- **NOT CHECKED**, named so the next wave knows the gap exists.

Line numbers drift. Cite by symbol name as well as line where the symbol is stable.

**Headline result: P3-1's premise holds.** The two questions that could have aborted this wave are
both answered yes. A device command result is readable by id through an authorized route
(`apps/api/src/routes/devices/commands.ts:960`, VERIFIED), and the proposed operation identity can
be made safe, though not in the shape §6.5 currently describes. Section 5 states the required
change. Section 11 lists twenty corrections to the spec and plan.

---

## 1. Typed execution adapter contract

The adapter is the seam between a task step and a domain executor. It exists because spec §6.5's
four facts are distinct and today's code collapses them. Take the thin slice's service restart.
`action_intents.status = 'completed'` means only that the tool call returned. For a device command
that means dispatch was accepted and a result was polled for up to 30 seconds. It does not mean the
domain operation finished, and it certainly does not mean the task criterion is verified.

### 1.1 Interface sketch

Illustrative TypeScript, not a source file. Types are named so W02 and P3-1 can implement against
them directly.

```ts
/** Immutable identity reserved before any effect. Spec §6.5. */
export interface OperationIdentity {
  orgId: string;
  taskId: string;
  taskStepKey: string;
  /** Stable within (org, task): step + target + workflow version + plan revision + ordinal. */
  operationKey: string;
  attemptOrdinal: number;
  workflowKey: string;
  workflowVersion: number;
  planRevision: number;
  /** computeArgumentDigest(canonicalizeArguments(args)); intentService.ts:1180-1181. */
  argumentDigest: string;
}

/** What a dispatch returns. Never a bare string id. */
export type ExecutionRef =
  | { kind: 'device_command'; commandId: string; deviceId: string }
  | { kind: 'script_execution'; executionId: string; deviceId: string }
  | { kind: 'patch_job_target'; jobId: string; targetId: string }
  | { kind: 'playbook_execution'; executionId: string }
  | { kind: 'ticket_comment'; ticketId: string; commentId: string }
  | { kind: 'report_delivery'; reportRunId: string };

export type AdmitResult =
  | { ok: true; identity: OperationIdentity; authority: FrozenAuthority }
  | { ok: false; reason: 'unsupported' | 'policy_denied' | 'guardrail_denied'
      | 'target_unavailable' | 'budget_exhausted' | 'kill_switch'; detail: string };

export type DispatchResult =
  | { state: 'accepted'; ref: ExecutionRef; intentId: string | null }
  | { state: 'awaiting_approval'; intentId: string }
  | { state: 'refused'; errorCode: string }
  /** Claim won, send outcome unknown. MUST reconcile; MUST NOT reissue. Spec §7.3. */
  | { state: 'unknown'; ref: ExecutionRef | null; errorCode: string };

export type ObserveResult =
  | { state: 'pending' }
  | { state: 'finished'; outcome: 'succeeded' | 'failed'; detail: BoundedResult }
  | { state: 'unknown'; reason: 'not_delivered' | 'timed_out' | 'evidence_erased' };

/** Mirrors ActVerificationVerdict (packages/shared/src/types/aiAgents.ts:719). */
export type VerifyResult =
  | { verdict: 'passed'; evidence: BoundedEvidence; observedAt: Date }
  | { verdict: 'failed'; evidence: BoundedEvidence; observedAt: Date }
  | { verdict: 'inconclusive'; reason: string }
  | { verdict: 'skipped'; reason: string };

export interface ExecutionAdapter {
  admit(identity: OperationIdentity, ctx: TaskAuthorityContext): Promise<AdmitResult>;
  dispatch(identity: OperationIdentity, ctx: TaskAuthorityContext): Promise<DispatchResult>;
  observe(ref: ExecutionRef, ctx: TaskReadContext): Promise<ObserveResult>;
  verify(identity: OperationIdentity, ref: ExecutionRef, criterion: TaskCriterion,
         ctx: TaskReadContext): Promise<VerifyResult>;
  cancelIfSupported(ref: ExecutionRef, ctx: TaskAuthorityContext):
    Promise<{ cancelled: boolean; reason: string }>;
  reconcileUnknown(identity: OperationIdentity, ref: ExecutionRef | null,
                   ctx: TaskReadContext): Promise<ObserveResult>;
}
```

### 1.2 Grounding, and what each method cannot do yet

| Method | Grounded in | Satisfies today (§6.5 / §7.3) | Cannot satisfy yet |
|---|---|---|---|
| `admit` | `createActionIntent` (`apps/api/src/services/actionIntents/intentService.ts:847`), whose input type `CreateActionIntentInput` (`:123-181`) is the full admission surface. Guardrails run before any write via `checkGuardrails` / `checkAgentGuardrails` (`apps/api/src/services/aiGuardrails.ts:1739`). VERIFIED. | Tier and guardrail gating, agent-principal pairing (`agent_source_mismatch`, `:858-868`), explicit device/ticket scope (`:170`), org resolution. | `CreateActionIntentInput` has **no** `taskId`, `taskStepKey` or `operationKey` field (VERIFIED, read the whole interface at `:123-181`). §6.5's "reserved durably before either an act dispatch or an intent is created" has no representation. Adding it is a change to this input type and to the creation transaction, exactly as §6.5 says. |
| `dispatch` | The `approved -> executing` CAS at `apps/api/src/jobs/intentReleaseWorker.ts:676`, `transitionIntent(intentId, 'approved', 'executing', { executedAt: null, executionStartedAt: new Date() }, { requireNotExpired: 'release' })`. VERIFIED. `transitionIntent`'s signature is `(intentId, from, to, patch?, opts?) => Promise<boolean>` (`intentService.ts:2134-2140`, VERIFIED). | A single durable claim already exists and already folds the release deadline into the CAS predicate (`:2158-2164`). This is the linearization point §7.3 asks for. | The CAS predicate has no task columns, so it cannot check task state, revision, deadline or `lease_epoch`. §7.3 is explicit that these are added to the *same* conditional UPDATE, not a second claim. `transitionIntent` returns `boolean`, it does not return the row, so a task-aware claim needs either a widened return or a separate read (INFERRED from the signature). |
| `dispatch` → `ExecutionRef` | `executeCommand` (`apps/api/src/services/commandQueue.ts:1194`) as used by `manage_services` (`apps/api/src/services/aiToolsScripts.ts:660`). Returns `CommandResult` (`commandQueue.ts:67-84`). VERIFIED. | `CommandResult.commandId` is the `device_commands` row id, attached "once a command row exists (success or failure)" (`commandQueue.ts:76-83`). That is a real, resolvable execution reference. | `commandId` is **optional** (`commandId?: string`, `:83`) and is "absent only on failures that occur before the row is created (device missing/offline, insert failure)". So `dispatch` must model a refusal with no reference. VERIFIED. |
| `observe` | `GET /devices/:id/commands/:commandId` (`apps/api/src/routes/devices/commands.ts:960-994`). VERIFIED. | Reads the persisted `device_commands.result` by id under `requireScope`, `requirePermission(DEVICES_READ)`, `getDeviceWithOrgCheck` and `canAccessDeviceSite`. | `device_commands` is deliberately **not** RLS-protected. It is listed in `INTENTIONAL_UNSCOPED` at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:88` ("Agent WS path: system-scoped command queue, no tenant isolation needed"), and the migration comment at `apps/api/migrations/2026-10-13-100000-device-commands-deliver-by.sql:11-17` says the same. VERIFIED. The app-layer device/org/site check **is** the whole authorization boundary. §11.3's "authorized adapter read on every access" is therefore load-bearing, not defence in depth. |
| `verify` | `actVerify.ts` `verifyServiceRunning` and `verifyActExecution`; `fixWatch.ts` phase 1/2. VERIFIED. | Typed verdicts already exist: `ActVerificationVerdict = 'passed' \| 'failed' \| 'inconclusive' \| 'skipped'` (`packages/shared/src/types/aiAgents.ts:719`) and `ActExecutionVerdict = 'succeeded' \| 'failed' \| 'timeout' \| 'unknown'` (`:710`). The two-axis split §6.5 wants is already the repo's vocabulary. | The two halves of the service criterion run on different clocks and cannot be combined into one call today. See §2.7. |
| `cancelIfSupported` | `POST /devices/:id/commands/:commandId/cancel` (`apps/api/src/routes/devices/commands.ts:1000-1090`). VERIFIED. | Cancels a command still in `status='pending'` via a CAS; returns 409 `Command is not pending` once claimed. | There is **no** in-flight cancel for a claimed `restart_service`. The adapter must answer `{ cancelled: false }` and the task must record in-flight, which is what §7.3 already requires. |
| `reconcileUnknown` | `commandAcceptsAgentResultCondition` (`apps/api/src/services/commandResultAcceptance.ts:55-66`). VERIFIED. | The device-command layer **already** treats a server-side timeout as provisional: a row that is `failed` with `result->>'status' = 'timeout'` still accepts a genuine agent result later (`:4-41`). Reconciliation of an unknown device effect is therefore possible from the reference alone. | Nothing propagates that late result back to the intent, which is terminal and immutable by then. The operation row is the only place it can land. This is precisely why §6.3/§6.5 put the result on the operation, not the intent. |

**The one contract that must not be weakened.** Every adapter read of an execution reference
authorizes at read time. `device_commands` has no RLS and `script_executions` is restamped across
orgs on device move (§9). A stored `(kind, id)` pair is a pointer, never an authorization.

---

## 2. Recipe card: Recover a supported service incident

The P3-1 slice. Supervised mode only, one device, intent path, no direct act.

### 2.1 Supported platforms

`restart_service` dispatches to `handleRestartService` (`agent/internal/heartbeat/handlers.go:157-159`)
which calls `tools.RestartService` (`agent/internal/remote/tools/services.go:154`). VERIFIED.

| OS | Implementation | Does the agent prove the service is running afterwards? |
|---|---|---|
| Windows | `restartServiceOS` (`agent/internal/remote/tools/services_windows.go:160-168`) stops then starts through `golang.org/x/sys/windows/svc/mgr`; `startServiceOS` (`:114-133`) ends with `waitForServiceState(s, svc.Running, 30*time.Second)`. | **Yes.** Waits for `Running`, up to 30 s. VERIFIED. |
| Linux | `restartServiceOS` (`services_linux.go:127-133`) runs `systemctl restart <name>.service` and fails on a non-zero exit. | **Partly.** `systemctl restart` blocks and reports failure, but the agent performs no state read of its own. VERIFIED. |
| macOS | `restartServiceOS` (`services_darwin.go:127-132`) calls `stopServiceOS` and **discards its error** (`:128-130`, an empty `if` body), then `startServiceOS` (`:102-113`) tries `launchctl kickstart -k`, falling back to `launchctl load -w`. | **No.** No state is read; a successful `kickstart` exit is the only evidence. VERIFIED. |

No other OS is supported: only `services_{windows,linux,darwin}.go` exist, so the build-tagged
`restartServiceOS` has no fallback (VERIFIED by directory listing).

Special case, all three OSes: `if isAgentService(name) { return RestartAgentService(startTime) }`
(`services.go:164-166`). Restarting Breeze's own agent returns success immediately and schedules a
delayed restart, so the response can outrun the process death. A task must never treat that as a
verified service recovery. Also note `StopService` refuses to stop the agent service outright
(`services.go:132-137`), but `RestartService` does not, it reroutes. VERIFIED.

**Consequence for the recipe.** The agent's `success: true` means "the restart command did not
error", and on macOS not even that much about the stop half. Recipe verification must be an
independent read (§2.7), never the dispatch result.

### 2.2 Input schema

Zod sketch. `deviceId` is the frozen target; `serviceName` is pinned at admission and is part of
the argument digest, so changing it is a new operation and a new approval (spec §7.1).

```ts
const ServiceRecoveryInput = z.object({
  deviceId: z.string().uuid(),
  serviceName: z.string().min(1).max(255),
  /** Frozen at admission. The alert whose recovery is half the success criterion. */
  triggeringAlertId: z.string().uuid().nullable(),
  /** Recipe-bounded; spec §7.2 caps mutation attempts per target at 3 across all runs. */
  maxRestartAttempts: z.number().int().min(1).max(2).default(1),
});
```

`serviceName` is validated again on the device by `validateServiceName`
(`agent/internal/remote/tools/services.go:9-23`), which trims, rejects `..`, path separators and
control characters, and bounds the length. VERIFIED. Server-side validation does not replace it.

### 2.3 Policy mapping

| Gate | Where | Value for this recipe |
|---|---|---|
| Action key | `apps/api/src/services/actionIntents/policyDecidableKeys.ts:97-104` | `manage_services:restart`, `headlessCompatible: true`, `maxTargetCardinality: 1`, `requiresEffectPin: true`. VERIFIED. |
| Tier / approval scope | `apps/api/src/services/aiGuardrails.ts:192` (`TIER3_ACTIONS`) and `:421-424` (`TIER3_SUPERVISED_ACTIONS`) | Tier 3, **supervised** (not four-eyes), resolved by `resolveApprovalScope` (`:555-598`). VERIFIED. |
| Agent policy | `AiAgentPolicy.actAssets` (`packages/shared/src/types/aiAgents.ts:359`), `AiAgentActAssets` (`:327-346`) | `supervisedActionKeys` must contain `manage_services:restart` for a policy-decided release. Partner is a **ceiling**: the effective set is `intersectToolRefs(partner.actAssets.supervisedActionKeys ?? [], ...)` at `apps/api/src/services/aiAgents/effectivePolicy.ts:297-299`, so an org-only grant does nothing unless the partner baseline already holds the key. With no org row at all the effective set is forced to `[]` (`:191-192`). VERIFIED. **Note the Phase 2 spec cites `:199` for this; that line is now an unrelated `pick` helper.** |
| Guardrail check | `checkAgentGuardrails` (`apps/api/src/services/aiGuardrails.ts:1739`) | In order: env flag, DB kill switch, snapshot validity, base tier, secret-bearing, human-only tools, site scope, `policy.enabled` / `mode !== 'off'`, tool allowlist, `protectedResources.services`, then the mode branch. VERIFIED. |
| Mode | same | `shadow` or unmatched `act` yields `disposition: 'propose'`; only a manifest-matched `act` executes directly. P3-1 is supervised only, so the propose path is the only one in scope. VERIFIED. |

A named service listed in `protectedResources.services` is denied before an intent exists. The
recipe must surface that as an admission refusal, not a failed operation.

### 2.4 Prerequisite reads

- `manage_services` with `action: 'list'` maps to command type `list_services`
  (`apps/api/src/services/aiToolsScripts.ts:651`), downgraded to Tier 1 by `checkGuardrails`
  (`apps/api/src/services/aiGuardrails.ts:75, 156`). No approval. VERIFIED.
- `actVerify.ts` issues its own `list_services` read (`apps/api/src/services/aiAgents/actVerify.ts:127-129`)
  through `executeCommandWithSystemPrecheck`. This is the same read the recipe needs for a
  baseline. VERIFIED.

A baseline read before dispatch is required, not optional: without it a "service already stopped
and stays stopped" case is indistinguishable from "restart succeeded then crashed".

### 2.5 Accepted result references

One kind: `{ kind: 'device_command', commandId, deviceId }`.

- The id is `CommandResult.commandId` = `device_commands.id`
  (`apps/api/src/services/commandQueue.ts:76-83`, and the two return sites at `:1156` and `:1169`).
  VERIFIED.
- The result lands in `device_commands.result` (jsonb) with `status` and `completed_at`
  (`apps/api/src/db/schema/devices.ts:536-561`). The agent WS ingest writes it
  (`apps/api/src/routes/agentWs.ts`, the `commandResult` frame handler). VERIFIED.
- Read path: `GET /devices/:id/commands/:commandId`
  (`apps/api/src/routes/devices/commands.ts:960-994`). VERIFIED.

**`device_commands` gets no `org_id`, on purpose.** `2026-10-13-100000-device-commands-deliver-by.sql:11-17`
adds `submitted_org_id` and states it is "PROVENANCE, NOT TENANCY … deliberately not named `org_id`:
the RLS-coverage and cascade contract tests auto-discover `org_id` columns, and this table must not
be reclassified as tenant-scoped." VERIFIED. An Operator operation row must therefore not attempt a
composite `(command_id, org_id)` FK, which matches §11.3's "typed `(execution_ref_kind,
execution_ref_id)`, **no hard FK**".

### 2.6 The three clocks

This is the most important operational fact in the slice, and it is not in the spec.

| Clock | Value | Where |
|---|---|---|
| Tool wait | **30 s** | `aiToolsScripts.ts:662` passes `timeoutMs: 30000`; `waitForCommandResult` polls until then (`commandQueue.ts:619, 625`). VERIFIED. |
| Device-command reap | **5 min** | `restart_service` is in `SHORT_TIMEOUT_TYPES` (`apps/api/src/services/commandTimeouts.ts:25-33`), so `getCommandTimeoutMs` returns `FIVE_MINUTES` (`:145`). VERIFIED. |
| Intent stale-executing reap | **20 min** | `STALE_EXECUTING_TIMEOUT_MINUTES = 20` (`apps/api/src/jobs/intentExpiryReaper.ts:81`). VERIFIED. |

So between 30 s and 5 min the tool has already returned `{status:'timeout'}` while the command is
still live and may yet succeed on the device. **That window is the recipe's normal "unknown effect"
case, not an exceptional one.** A 30-second tool wait against a Windows service manager that itself
waits up to 30 s for `Running` (§2.1) makes this reachable on a healthy device.

Recovery exists at the device layer and must be used: `commandAcceptsAgentResultCondition`
(`apps/api/src/services/commandResultAcceptance.ts:55-66`) keeps a server-timeout row open to a
genuine late agent result, and its header (`:4-41`) records that narrowing this set once destroyed
real script output. Every server-side timeout writer stamps `result.status = 'timeout'`
(`SERVER_TIMEOUT_RESULT_STATUS`, `:47`) so the row stays reconcilable.

### 2.7 Verification criterion

Two conditions, two mechanisms, two clocks. Both are required; neither alone is "recovered".

1. **Service is running.** `verifyServiceRunning` (`apps/api/src/services/aiAgents/actVerify.ts:116-144`),
   reached from `verifyActExecution`'s `case 'service_running'`. Issues a fresh `list_services`
   read bounded by `VERIFY_READ_TIMEOUT_MS = 8_000` (`actVerify.ts:75`). Read fails to complete →
   `inconclusive`; read completes and the service is not running or not found → `failed`. VERIFIED.
2. **Triggering alert cleared and stayed cleared.** `fixWatch.ts`. Phase 1
   (`checkFixWatchPhase1`) polls `alerts.status`: `resolved` moves the watch to `watching` with
   `dueAt = now + FIX_HOLD_MINUTES`; `dismissed` cancels the watch, because a human dismissal is
   not recovery; anything else keeps waiting up to `RECOVERY_TIMEOUT_HOURS` from the watch's
   `created_at`, then gives up. Phase 2 checks recurrence and, if none, reaches `held_qualified`.
   `FIX_HOLD_MINUTES = 60` (`fixWatch.ts:66`), `RECOVERY_TIMEOUT_HOURS = 24` (`:67`). VERIFIED.

**"Fresh within N minutes" does not exist as a parameter today.** The nearest things are
`VERIFY_READ_TIMEOUT_MS` (8 s, a read *deadline*, not a staleness bound) and `FIX_HOLD_MINUTES`
(60 min, a *recurrence hold*, not a freshness window). VERIFIED by reading all three constants.
P3-1 must introduce an explicit freshness bound on the criterion, or state that phase-1 recovery
plus the 60-minute hold is the freshness contract. It cannot cite an existing parameter.

**The two halves are already chained.** `isFixWatchEligible` (`fixWatch.ts:133-139`) requires
`modeAtStart === 'act'`, `runVerdict !== 'needs_attention'`, and at least one executed action with
both `execution === 'succeeded'` and `verification === 'passed'`. So the alert watch only opens on
top of a passed service-running check. VERIFIED. A task-level criterion can reuse this ordering
directly, but note the mode requirement: a **supervised** P3-1 run is not `modeAtStart === 'act'`,
so the existing eligibility gate does not fire for it. See contradiction C11.

**Task success:** `verified_resolved` requires (1) `passed` **and** (2) `held_qualified`.
`inconclusive` on either half can never resolve the task (spec §13 acceptance scenario 7); it waits
or hands off.

### 2.8 Cancellation

- Before the agent claims the row: `POST /devices/:id/commands/:commandId/cancel`
  (`apps/api/src/routes/devices/commands.ts:1000-1090`) CASes `pending -> cancelled` and returns
  409 once the status has advanced. VERIFIED.
- After the agent claims it: **no mechanism exists.** Scripts have `cancel_script_execution`;
  `restart_service` has no equivalent. VERIFIED.
- Intent-level cancel covers only `pending_approval` and `approved`
  (`apps/api/src/services/actionIntents/intentService.ts:2043-2048`). An `executing` intent cannot
  be cancelled today. VERIFIED.

So the recipe's cancellation contract is: fence new claims, cancel a pending device command if one
exists, and otherwise record in flight and reconcile. This is exactly §7.3, and it needs the
`executing` extension that §7.3 already scopes into P3-1.

### 2.9 Failure and unknown cases

| Case | Detection | Task outcome |
|---|---|---|
| Guardrail or protected-service denial | `checkAgentGuardrails` returns `deny`; `createActionIntent` throws `agent_policy_denied` (`intentService.ts:1172-1177`) | Admission refusal. No operation row. |
| Device offline at dispatch | `precheckCommandExecution` (`commandQueue.ts:852`); `CommandResult` has no `commandId` (`:1156` returns `DEVICE_UNREACHABLE_ERROR` **with** `commandId`; the pre-row failures do not) | `refused`. Retryable under the recipe's bounded policy, confirmed non-execution. |
| Agent reports failure | `NewErrorResult` → `result.status = 'failed'` | `observe` → `finished/failed`. Not retried blindly. |
| Tool wait elapsed, command live | `result.status = 'timeout'` written by `waitForCommandResult` (`commandQueue.ts:647-670`) | `unknown`. **Do not retry.** Reconcile via the command id. |
| Never delivered | `deliver_by` passed; reaper reason `not_delivered_before_deadline` (`apps/api/migrations/2026-10-13-100000-device-commands-deliver-by.sql:3-9`, `apps/api/src/jobs/staleCommandReaper.ts`) | Confirmed non-execution. Retryable once (§7.2). |
| Intent lost at 20 min | `failed` + `error_code = 'execution_lost'` (`intentExpiryReaper.ts:274-276`) | Intent is terminal, result unknown. Operation row must still reconcile. See §4. |
| Device moved org mid-flight | `submitted_org_id` records the enqueue-time org so claim-time eligibility can cancel (migration `:11-17`) | Target detach; fence. |
| Verification inconclusive | `actVerify` read did not complete, or `fixWatch` hit `RECOVERY_TIMEOUT_HOURS` | Never `resolved`. Hand off. |

### 2.10 Unavailable until: Investigate a device or alert

Spec §4 requires "investigation complete, with uncertainty and an actionable recommendation; never
labeled fixed". Missing against §4:

- **No uniform actionable proposal contract for a recommendation.** Free-form Tier-2 proposals in
  full runs do not create approval objects; `recordProposal` in
  `apps/api/src/services/aiAgents/runLoop.ts` records a proposal on the run outcome only, and
  `mapProposed` (`apps/api/src/services/aiAgents/runTrace.ts:217-230`) deliberately never exposes
  `action.args`. There is no object a technician can act on. VERIFIED.
- **No verification adapter.** The workflow's "required result" is an evidence-quality judgement,
  not a device state. Nothing in `actVerify.ts` expresses it, and §4 offers no criterion type.
  VERIFIED (by absence in `verifyActExecution`'s cases).
- **No cancellation semantics needed but none defined either**, an investigation has no external
  effect, so `cancelIfSupported` is trivially `{cancelled:true}`; that is a design statement P3-4
  must still make.
- **Raw-trace exposure is gated on #4181** (§8). An investigation's value is its evidence, and the
  safe projection for evidence is not yet defined beyond the run DTO's field allowlist.

Blocked on: a proposal object contract (P3-4), a criterion type for "evidence sufficient",
and the #4181 redaction contract.

### 2.11 Unavailable until: Recover disk capacity

Spec §4 requires "the affected volume meets the task's approved free-space/usage criterion".
Missing against §4:

- **No pinned-cleanup execution adapter.** §4's procedure is baseline → preview → execute pinned
  cleanup → remeasure. `aiToolsFilesystem.ts` exposes `filesystem_analysis` and `file_delete`
  (`apps/api/src/services/aiToolsFilesystem.ts:169, 328`) as separate commands. There is no
  approved-plan object binding a previewed set of deletions to the execution that performs them,
  so "execute pinned cleanup" has nothing to pin. VERIFIED (by reading both call sites).
- **No `maxTargetCardinality`-style bound on a multi-item delete**, unlike
  `manage_services:restart` which is explicitly `1` (`policyDecidableKeys.ts:97-104`). Deleting N
  paths is N effects under one approval, which §6.5 forbids ("one execution owner" per operation).
- **No volume-measurement verification criterion.** `verifyActExecution` has a `service_running`
  case; there is no free-space case. VERIFIED by absence.
- **Compensation is impossible.** §7.3 says cancellation is not rollback and compensation is a
  distinct approved operation. A deleted file has no compensating operation, so the recipe needs an
  explicit "no compensation" statement and a stricter approval ceremony than service restart.

Blocked on: an approved-plan/pinned-argument object, a per-item operation decomposition, and a
free-space verification adapter.

---

## 3. Terminal-writer inventory

Every path that writes a terminal status to `ai_agent_runs` or `action_intents`. This is the
contract-test target for W05; completeness matters more than prose.

**Status vocabularies.**

- `AI_AGENT_RUN_STATUSES = ['queued','running','awaiting_approval','completed','failed','cancelled','expired','skipped']`
  (`packages/shared/src/types/aiAgents.ts:14-16`). Terminal: `completed`, `failed`, `cancelled`,
  `expired`, `skipped`. VERIFIED.
- `action_intents.status` has eight values: `pending_approval`, `approved`, `executing`,
  `completed`, `failed`, `rejected`, `expired`, `cancelled`
  (`apps/api/src/db/schema/actionIntents.ts:45-54`). Live:
  `LIVE_INTENT_STATUSES = ['pending_approval','approved','executing']`
  (`apps/api/src/services/actionIntents/intentService.ts:55`). The other five are terminal.
  VERIFIED.

`isTerminalRunStatus` (`apps/api/src/services/aiAgents/agentCircuit.ts:207-209`) treats everything
except `queued` and `running` as terminal, so `awaiting_approval` counts as terminal for
circuit-breaker purposes even though a human owns the follow-up. VERIFIED.

**Shared primitives.** `transitionRunStatus` is a CAS
(`update(aiAgentRuns).set({...patch, status: to}).where(and(eq(id), inArray(status, fromStatuses), guard))`,
`apps/api/src/services/aiAgents/runService.ts:1217-1274`) returning a boolean. `transitionIntent`
(`intentService.ts:2134-2182`) is the same shape with an optional deadline fold. Neither publishes
anything; publication is always the caller's job, always after the write. VERIFIED.

**The two tables differ in a way that matters to W05.** Run terminalization has an *enforced*
chokepoint: `runService.terminalization.contract.test.ts` is a regex source scan asserting no other
file in `src/` writes a terminal literal directly onto `aiAgentRuns`. VERIFIED. Intents have no such
test. `transitionIntent` is the shared primitive, but several call sites deliberately bypass it to
get an outbox row or a sibling-table write into the *same* transaction. **W05 should add the intent
equivalent of that contract test**; it is the mechanism that keeps this inventory from rotting.
Two working precedents supply the source-scan mechanism:
`apps/api/src/services/aiAgents/runService.terminalization.contract.test.ts` and the
`apps/api/src/jobs/agentDispatchBoundary.contract.test.ts` it says it mirrors. The run test's header
gives the rationale in one line: a writer that bypasses the chokepoint "would silently starve the
per-org circuit breaker of the failures it exists to count." VERIFIED.

### 3.1 `ai_agent_runs` terminal writers

| file:line | function | status written | in a transaction? | publishes afterwards | result payload |
|---|---|---|---|---|---|
| `services/aiAgents/runLoop.ts:1898` (in `finishRun`, `:1892`) | `finishRun` | `completed` / `failed` / `awaiting_approval` (the three `TERMINAL_EVENT` keys, `:1787-1791`) | the CAS runs in `inSystemDbContext` inside `transitionRunStatus` | `safePublish(TERMINAL_EVENT[status], ...)` at `:1916`, **after** the write returns, with `runId`, `agentId`, `deviceId`, `intentIds`, `costCents`, `errorCode`; then best-effort notifications, fix watch and op evidence | Writes `summary`, `outcome` (jsonb), `intentIds`, `turnCount`, `costCents`, `finishedAt` in the same `set()` |
| `services/aiAgents/runLoop.ts:1621` | `executeAgentRun` stop gate | `skipped`, `errorCode: 'policy_revoked_before_start'` | same chokepoint | `safePublish('ai.agent.run.skipped', ...)` | none |
| `services/aiAgents/runLoop.ts:1768` | `executeAgentRun` catch block | `failed`, error code from the thrown `AgentRunError` / `AgentRunOwnershipError`, else `run_failed` | same chokepoint | `safePublish('ai.agent.run.failed', ...)`, only if the CAS won | none |
| `services/aiAgents/runService.ts:593` (in `reapStalledAgentRuns`) | stalled reaper | `failed`, `errorCode: 'stalled'`, `finishedAt` | CAS with an extra `stale` guard re-checking the cutoff atomically (`:585-596`) | nothing, returns `reapedIds` to its caller | none; the run's own outcome is left as it was |
| `services/aiAgents/runService.ts:1184` | enqueue-failure path | `failed`, `errorCode: 'enqueue_failed'`, `finishedAt` | CAS, then a separate `inSystemDbContext` read for the full row (`:1189-1192`) | nothing | none |
| `services/aiAgents/runService.ts:1099` (the reclaim after `:1074-1078`) | `createAndEnqueueAgentRun` dedupe reclaim | **un-terminalizes**: CASes a `failed`/`enqueue_failed` row back to `queued` and re-stamps `queuedAt` | inside the same transaction and advisory lock as the counters | nothing | clears the prior failure |

The last row is not a terminal write but belongs in the inventory: it is the only path that moves a
run *out* of a terminal state, and a task-admission contract test must know a `(org_id, dedupe_key)`
row can be resurrected. It is also the one raw `.update(aiAgentRuns)` that the terminalization
contract test tolerates, precisely because it writes `queued`, not a terminal value. VERIFIED at
`:1082-1099`.

**`cancelled` and `expired` have no production writer for runs.** Both are valid per
`AI_AGENT_RUN_STATUSES` and the `ai_agent_runs_status_chk` CHECK
(`apps/api/migrations/2026-09-02-ai-agents.sql:112`), but no `transitionRunStatus` call site passes
either as `to`, and there is no cancel-run route. VERIFIED by enumerating every call site (§3.1).
So spec §7.3's task cancel has no existing run-level cancel to compose with: cancelling a task
cannot cancel its in-flight run today, only fence future admissions. P3-1 should say so explicitly
rather than implying a run cancel exists.

### 3.2 `action_intents` terminal writers

| file:line | function | status written | in a transaction? | publishes afterwards | result payload |
|---|---|---|---|---|---|
| `jobs/intentReleaseWorker.ts:541` (in `terminalizeIntent`, `:529`) | `terminalizeIntent` | `completed` or `failed` | **Yes**, `withSystemDbAccessContext` wrapping the CAS, the `recordIntentTerminalEvidence` insert and the `onWon` callback (`:540-558`) | **No outbox row.** The fix-watch job is enqueued strictly after the transaction closes (`:1078-1082`), swallowing failures because `recoverStrandedFixWatches` re-adds it | `patch` carries `executedAt` and the sealed `result`; sealing and the size cap run before the CAS (`:1029-1042`) |
| `jobs/intentReleaseWorker.ts:139` | kill-switch reversal | `executing -> approved` (**not terminal**, listed because §7.3 extends it) | bare CAS | nothing | none |
| `jobs/intentReleaseWorker.ts:676` | `releaseApprovedIntent` claim | `approved -> executing` (not terminal) | bare CAS with `requireNotExpired: 'release'` | nothing | sets `executionStartedAt`, clears `executedAt` |
| `jobs/intentReleaseWorker.ts:601` (`failIntent`, wrapping `terminalizeIntent`) | revalidation stop (`:748`), digest recompute failure (`:831`), content changed (`:840`), `session_required` (`:858`), `connection_unavailable` (`:962`), `execution_error` (`:968`), plaintext-secret guard via `failOnPlaintextSecretGuard` (`:650`) | `failed` | same transaction as `terminalizeIntent` | no outbox row | no `result`; deliberately omitted on the secret-guard path |
| `jobs/intentExpiryReaper.ts:132-230` (`reapExpiredIntents`) | deadline sweep | `expired`, from `pending_approval` and `approved` | one transaction, CTE `UPDATE` | `intent_outbox` row `intent_expired` in the **same** transaction, unconditional, and the file's header records that errors here **propagate by design** after a past bug | n/a |
| `jobs/intentExpiryReaper.ts:274-276` | `reapStaleExecutingIntents` | `failed`, `error_code = 'execution_lost'` | one `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` statement (`:262-288`) | writes an audit event and a metric per row, both best-effort; **no outbox row** | **none, the result column is not written at all** |
| `services/actionIntents/intentService.ts:725-726` (`runHumanFanout`) | fail-closed when no approver is eligible | `cancelled`, `errorCode: 'no_eligible_approvers'` | **Yes**, joins the caller's transaction (`createActionIntent` at `:1334`, `runDeferredHumanFanout` at `:1884`) | the unconditional `intent_created` row still fires at `:1600` | n/a; never executed |
| `services/approvals/decideApprovalRequest.ts:985-993` | human denial | `rejected` | **Yes**, `withSystemDbAccessContext(() => db.transaction(...))` at `:775`, bundled with the elevation mirror and the `ai_tool_executions` mirror | `intent_outbox` row, same transaction, `:1027-1032` | n/a |
| `services/actionIntents/policyDecide.ts:349-364` (`runAuthorizeTransaction`) | policy auto-authorize | `approved` (**never terminal**) | **Yes**, one transaction | `intent_outbox` row `intent_approved`, same transaction, `:379` | n/a |
| `routes/approvals.ts:992-994` | "report suspicious" | `rejected` | **Yes**, `runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(...)))` at `:958-960` | **nothing.** No `intentOutbox` insert exists anywhere in that file | n/a |
| `services/actionIntents/intentService.ts:2043-2056` | `cancelActionIntent` | `cancelled`, from `['pending_approval','approved']` only | **Yes**, `withSystemDbAccessContext`; the outbox insert shares the transaction so a throw rolls the status back (`:2058-2072`) | `intent_outbox` row `intent_cancelled`, ids only (`:2051-2056`) | none |
| `services/approvals/decideApprovalRequest.ts:1027-1032` | approval decision | intent CAS to `approved` (not terminal) or the denial path to `rejected` | **Yes**, inside `tx`, alongside expiring sibling `approval_requests` rows (`:1010-1019`) | `intent_outbox` row `intent_approved` / `intent_rejected`, ids only | none |
| `services/aiAgentSdk.ts:1210` | inline session release claim | `approved -> executing` (not terminal) | bare CAS with `requireNotExpired: 'release'` | nothing | sets `executionStartedAt` |
| `services/aiAgentSdk.ts:1279` | revalidation refusal | `failed`, `errorCode: revalidation.errorCode` | bare CAS | nothing | none |
| `services/aiAgentSdk.ts:1324` | inline pre-execution failure | `failed` | bare CAS | nothing | none |
| `services/aiAgentSdk.ts:1387` | inline execution error | `failed`, `errorCode: 'execution_error'` | bare CAS | nothing | none |
| `services/aiAgentSdk.ts:1903` | plaintext-secret guard trip | `failed`, `errorCode: SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE` | bare CAS inside a `try` | nothing | **deliberately none, refuses to persist** |
| `services/aiAgentSdk.ts:1918` | inline post-tool terminal | `completed` or `failed` | bare CAS | **nothing** | writes `executedAt` and `result: sizedResult` |

**Two writers stand out as gaps.** `routes/approvals.ts:992-994` terminalizes an intent to
`rejected` and publishes nothing at all, so a requester whose turn has ended is never told. And
`reapStaleExecutingIntents`, the writer that handles precisely the lost-execution case a task cares
about, also publishes nothing. Both are in scope for P3-1's "terminal publication" PR if a
task-linked intent can reach them, and a task-linked intent can reach both.

`policyDecide.ts` never writes a terminal status; it only auto-authorizes to `approved`. The
creation-time `approved` stamp for a ticket-autonomy grant is a separate path, inside
`createActionIntent`'s own transaction (`intentService.ts:1465-1476`). VERIFIED.

Excluded as non-writers of terminal state, checked and rejected:
`services/actionIntents/resultSecrets.ts:103` (redacts `result` only) and
`services/ticketService.ts:2344, 2392` (org-move tombstones of `scopeTicketId` / `ticketId`).

### 3.3 Outbox event vocabulary

```
intentOutboxEventEnum = ['intent_created', 'intent_approved', 'intent_rejected',
                         'intent_expired', 'intent_cancelled', 'pam.desired_state_changed']
```
`apps/api/src/db/schema/actionIntents.ts:92-99`, matching the CHECK constraint in
`apps/api/migrations/2026-10-08-100300-intent-cancelled-outbox-event.sql:8-13`, the latest of four
successive widenings (`2026-07-18` → `2026-09-04` → `2026-09-16` → `2026-10-08`). VERIFIED.

**There is no `intent_completed` and no `intent_failed`.** Both terminal writers that matter for the
slice, `terminalizeIntent` and the stale-executing reaper, publish nothing. This confirms spec §2
and is the concrete gap P3-1's PR (3) fills. Adding two values means a fifth widening migration.

Complete list of outbox writers, all read: `intentService.ts:1600` (`intent_created`), `:1621`
(`intent_approved`, ticket autonomy), `:2050` (`intent_cancelled`); `policyDecide.ts:379`
(`intent_approved`); `decideApprovalRequest.ts:1027-1032` (`intent_approved` / `intent_rejected`);
`intentExpiryReaper.ts:217-224` (`intent_expired`); `pamActuationLifecycle.ts:62`
(`pam.desired_state_changed`, unrelated to intent status). VERIFIED.

Payloads are ids only everywhere, `{ intentId, orgId }`. The publisher
(`apps/api/src/jobs/intentOutboxPublisher.ts`, `publishOutboxRows`) drains rows into an internal
BullMQ queue; the consumer re-reads the authoritative row rather than trusting the payload. VERIFIED.

**How a completed or failed outcome reaches a requester today, and why it is not a substitute.**
`releaseAndNotify` (`intentReleaseWorker.ts:1567-1582`) handles the `intent_approved` job by running
`releaseApprovedIntent` synchronously through revalidate, execute and terminalize, and only then
calls `notifyRequesterOfOutcome(intentId, 'intent_approved')` (`:1578`), which **re-reads the live
status** (`:1285-1287`) and switches on it (`agentOutcomeCopy`, `:1251-1274`; requester switch
`:1393-1420`). So the outcome is surfaced as a side effect of the *approved* event's post-release
re-read. Nothing fires if the status changes again after that job returns, which is exactly what the
stale-executing reaper does 20 minutes later. The code comments at `:1394-1401` already record this
as a known limitation. A durable task cannot continue on this mechanism; it needs the real events.
VERIFIED.

---

## 4. Late-result and CAS-loss behaviour

Both of spec §2's claims are **confirmed**, and there is a third loss the spec does not mention.

**Claim 1, the reaper writes `failed:execution_lost`.** Confirmed.
`apps/api/src/jobs/intentExpiryReaper.ts:261-288`:

```sql
WITH due AS (
  SELECT id FROM action_intents
  WHERE status = 'executing' AND executed_at IS NULL
    AND COALESCE(execution_started_at, decided_at) < now() - (20 * interval '1 minute')
  ORDER BY COALESCE(execution_started_at, decided_at) ASC
  LIMIT ... FOR UPDATE SKIP LOCKED
)
UPDATE action_intents AS a
SET status = 'failed', error_code = 'execution_lost'
FROM due WHERE a.id = due.id AND a.status = 'executing' AND a.executed_at IS NULL
```

`STALE_EXECUTING_TIMEOUT_MINUTES = 20` (`:81`). Note what the SET clause does **not** contain: no
`result`, no `executed_at`. The execution's result has nowhere to go. VERIFIED.

**Claim 2, the losing worker discards the result.** Confirmed, and the code says so itself.
`apps/api/src/jobs/intentReleaseWorker.ts:1053-1068`:

```ts
if (!completed) {
  // Lost the executing -> completed CAS AFTER the tool already ran (via
  // executeTool or executeGoogleToolHeadless) and had its real-world side
  // effect (e.g. the stale-executing reaper beat us to failed:execution_lost
  // on an extremely slow tool call, or a duplicate delivery raced this one to
  // the terminal state first). The side effect already happened and cannot be
  // undone; there is nothing more to CAS, but this is worth surfacing — it
  // means the result this execution produced is not recorded anywhere on the intent.
  console.error(...);
  captureException(new Error(`intent ${intent.id} executed but lost the completed CAS`));
  return;
}
```

The result reaches a Sentry event and a log line, and nothing else. VERIFIED.

Note the precision point: it is `status = 'failed'` plus `error_code = 'execution_lost'` as two
columns. `failed:execution_lost` is the codebase's informal shorthand for the pair, not a stored
value.

**The third loss, not in the spec, and it is worse than either.** All five `aiAgentSdk.ts`
`transitionIntent` call sites (`:1279`, `:1324`, `:1387`, `:1903`, `:1918`) **ignore the return
value**. `transitionIntent`'s own contract (`intentService.ts:2110-2112`) is that a lost race
"returns `false`, never throws". The `try/catch` at `:1926-1928` therefore only fires on a thrown
error; the actual race returns `false` and falls straight through. So the inline chat-session path
can execute a real tool, lose the CAS to the durable worker or the reaper, and discard `sizedResult`
with **no log line, no Sentry event, no audit row, no signal at all.** That is a strictly more
silent version of the gap `intentReleaseWorker.ts:1053-1068` explicitly instruments. VERIFIED by
reading all five call sites.

This is worth raising outside the Operator program: it is a pre-existing observability hole on a
path that has already executed a customer-visible side effect.

**Which writers can lose a race, and what happens to the result.**

| Writer | Race | Result today |
|---|---|---|
| `terminalizeIntent` (`intentReleaseWorker.ts:541`) | reaper or duplicate delivery terminalized first | Discarded; Sentry event raised (`:1053-1068`) |
| `aiAgentSdk.ts:1918` | durable worker or reaper won | Discarded **silently** |
| `aiAgentSdk.ts:1210` / `intentReleaseWorker.ts:676` | both claim `approved -> executing` | Correct: exactly one wins, the loser does not run the tool (`aiAgentSdk.ts:1220-1229`). No loss |
| `intentExpiryReaper.ts:274` | the worker is mid-tool | Reaper wins; worker's result then hits the `terminalizeIntent` loss above |
| `finishRun` (`runLoop.ts:1898`) | run cancelled or a second executor finished it | `moved === false`, logged, the loop stops writing (`:1907-1913`). Outcome discarded |

**The device layer does not lose the result, only the intent layer does.** A device command
whose server-side timeout wrote `result.status = 'timeout'` still accepts the genuine agent result
later (`apps/api/src/services/commandResultAcceptance.ts:55-66`), and double delivery stays safe
because the acceptance predicate is re-evaluated inside the terminal CAS (`:37-41`). VERIFIED.

**Design consequence for P3-1.** The truth about the effect survives at the execution reference and
is destroyed at the intent. So the operation row must be written from the reference, on its own
schedule, and must never be gated on the intent CAS. This is what §6.3 and §6.5 already require;
this section is the evidence that it is required, not merely tidy. Concretely, P3-1's reconciler
should treat `device_commands` as authoritative and `action_intents.status` as advisory once an
execution reference exists.

---

## 5. Operation identity predicate

### 5.1 What exists

**Default key is run-scoped.** `deriveIdempotencyKey`
(`apps/api/src/services/actionIntents/intentService.ts:435-445`) hashes
`` `${actorId}:${actionName}:${digest}` `` plus an optional scope id, and the call site
(`:1186-1198`) passes `agentRun ? agentRun.id : requesterId`. The comment at `:1182-1185` states the
intent: "two runs of the same agent proposing identical arguments must yield DISTINCT intents, an
intent is immutably attributed to one run, whose policy snapshot the release path evaluates."
VERIFIED. Spec §6.5's characterisation is exact.

**Partial unique index.** `apps/api/migrations/2026-07-18-action-intents.sql:84-86`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_org_idem_uniq
  ON action_intents (org_id, idempotency_key)
  WHERE status IN ('pending_approval', 'approved', 'executing');
```

VERIFIED. The predicate matches `LIVE_INTENT_STATUSES` (`intentService.ts:55`) exactly, and the
`onConflictDoNothing` target must match it or Postgres cannot infer the index
(`:1476-1486`, and the code comment says so).

**The "reused by another run" rejection.** `intentService.ts:1517-1537`:

```ts
if (
  existing.actionName !== input.toolName ||
  existing.source !== input.source ||
  (existing.requestingAgentRunId ?? null) !== (agentRun?.id ?? null) ||
  existing.argumentDigest !== argumentDigest
) {
  throw new ActionIntentError(
    'Idempotency key already belongs to a different live request (action/source/run/arguments mismatch)',
    'idempotency_conflict',
  );
}
```

VERIFIED. It is a four-field match, and run identity is one of the four, not the whole key.

**Creation is one system-scoped transaction.** `withSystemDbAccessContext` at `:1334` wraps the
effect-digest computation, the insert and the outbox row, and the header at `:1320-1331` explains
the deliberate trade of an RLS re-check for atomicity. VERIFIED. So binding an operation row inside
intent creation is mechanically available; §6.5's "bind an intent atomically during intent creation"
is achievable without restructuring.

### 5.2 The exact predicate to write

```sql
-- Partial unique for task-scoped operation identity.
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_task_operation_uniq
  ON action_intents (org_id, task_id, operation_key)
  WHERE task_id IS NOT NULL
    AND status IN ('pending_approval', 'approved', 'executing');
```

The `task_id IS NOT NULL` conjunct is **required**, not decorative. Without it the index is still
technically correct. Postgres treats NULLs as distinct, so legacy rows never collide, but the
index would carry every legacy row for no benefit, and the predicate would no longer state the
invariant it enforces. State the predicate as literals, never interpolated values (spec §11.1).

**All-or-none CHECK:**

```sql
ALTER TABLE action_intents ADD CONSTRAINT action_intents_task_link_chk CHECK (
  (task_id IS NULL AND task_step_key IS NULL AND operation_key IS NULL)
  OR (task_id IS NOT NULL AND task_step_key IS NOT NULL AND operation_key IS NOT NULL)
);
```

**Same-task relaxation.** The `:1517-1537` rejection becomes:

```ts
const sameTaskReuse =
  existing.taskId !== null &&
  existing.taskId === input.task?.taskId &&
  existing.operationKey === input.task?.operationKey;

if (
  existing.actionName !== input.toolName ||
  existing.source !== input.source ||
  (!sameTaskReuse && (existing.requestingAgentRunId ?? null) !== (agentRun?.id ?? null)) ||
  existing.argumentDigest !== argumentDigest
) { throw ... }
```

The run check is relaxed **only** when both task id and operation key match. Action name, source and
argument digest still all have to match, so a continuation run cannot attach to an intent for
different arguments, which is what makes the relaxation safe at all.

### 5.3 Five hazards, one of them blocking

**H1, two arbiter indexes, one ON CONFLICT clause. This is the blocking one.** Postgres's
`ON CONFLICT` with an explicit inference target suppresses conflicts on **that arbiter only**. The
existing insert names `(org_id, idempotency_key)` (`intentService.ts:1483-1486`). A task-scoped
insert that collides on the *new* index raises a bare 23505 that the current code path does not
catch, and `createActionIntent` would surface it as an unhandled error rather than as an idempotent
replay. VERIFIED as a consequence of the read code plus documented Postgres semantics.

**Fix, and it is the cheap one: do not add a second arbiter.** Derive the task-linked intent's
`idempotency_key` from the task identity instead of the run:

```ts
const idempotencyKey = input.idempotencyKey
  ?? (input.task
      ? deriveIdempotencyKey(`task:${input.task.taskId}`, input.toolName, argumentDigest,
                             input.task.operationKey)
      : deriveIdempotencyKey(agentRun ? agentRun.id : requesterId, input.toolName,
                             argumentDigest, scopeDeviceId ?? scopeTicketId ?? null));
```

Then the **existing** index already enforces one live intent per `(org, task, operation)`, the
existing `onConflictDoNothing` already converges a continuation run onto it, and the new
`(org_id, task_id, operation_key)` index becomes a redundant assertion rather than a second arbiter.
Keep it as a `CONSTRAINT … NOT VALID`-style belt if desired, or drop it. Either way, **one arbiter.**
This is a change to what §6.5 says ("a partial unique index on `(org_id, task_id, operation_key)`
over live statuses"), see contradiction C6.

**H2, a completed intent frees the key while the effect is in flight.** `completed` and `failed`
leave `LIVE_INTENT_STATUSES`, so the moment `terminalizeIntent` fires, the operation key is
reusable. For the thin slice this is not hypothetical: §2.6 shows the intent completes when the
30-second tool wait returns, which may be minutes before the device finishes. So **the live-only
predicate cannot be the replay guard for a confirmed effect.** Replay protection must come from the
permanent `ai_operator_operations` row (unique on `(org_id, task_id, operation_key)` with no status
predicate), which §6.5 already specifies as "a permanent copy on the operation row". Record this
explicitly: the intent index guards *concurrent* duplication; the operation row guards *sequential*
replay. VERIFIED (the status sets and the timing chain were both read).

**H3, the relaxation crosses a documented policy-snapshot invariant.** `:1182-1185` ties run
scoping to the fact that the release path evaluates the originating run's immutable policy snapshot.
If run B attaches to run A's intent, release evaluates **A's** snapshot. A later run under a
*tightened* policy would then execute under the earlier, looser snapshot. Spec §7.1 already forbids
the outcome ("Tightening takes effect immediately"), so the relaxation must be paired with a
live-authority recheck at the dispatch claim, not only at creation. `revalidateApprovedIntentForRelease`
already exists on the release path (`intentReleaseWorker.ts:700-710` region, VERIFIED by reference)
and is the natural place. Do not ship the relaxation without it.

**H4. NULL semantics are load-bearing in the right direction.** Legacy rows have
`task_id IS NULL` and are mutually non-colliding, so no existing behaviour changes. This is correct,
but it means the index enforces nothing unless the application always populates all three columns
for task-linked intents. The CHECK enforces all-or-none, not all-or-task. INFERRED: the real
guarantee has to come from the single task-aware creation path, and a contract test should assert
that a task-linked admission never produces a null `operation_key`.

**H5, export policy, not RLS.** Adding columns needs no new RLS policy: `action_intents` is
shape 1 with `breeze_has_org_access(org_id)` (`apps/api/migrations/2026-07-18-action-intents.sql:130-146`).
But `action_intents` is already in `CORE_TENANT_EXPORT_POLICY`
(`apps/api/src/services/tenantExportPolicyRegistry.ts:44`), so **three new columns must be classified
in the same PR** or Integration Tests goes red. All three are `included` (§8.4). This is the
column-not-table trap CLAUDE.md calls out. VERIFIED.

### 5.4 Blocking question, answered

**Can the device command result be read back by id?** **Yes.**
`GET /devices/:id/commands/:commandId` (`apps/api/src/routes/devices/commands.ts:960-994`) selects
`device_commands` by `(id, deviceId)` after `getDeviceWithOrgCheck` and `canAccessDeviceSite`, and
returns the row through `sanitizeCommandForHistory`. VERIFIED. P3-1's execution reference is viable.
The caveat is §1.2's: the table has no RLS, so this app-layer check is the only boundary and the
adapter must always go through it, never a direct `db.select()` on `device_commands`.

**No abort.** Both premises hold.

---

## 6. Legacy trigger admission owners and sunset list

Every path that automatically admits an `ai_agent_runs` row today. The single entry point is
`createAndEnqueueAgentRun` (`apps/api/src/services/aiAgents/runService.ts:702`); this list is its
callers, minus the human "run now" route.

**`dedupeKey` is not computed centrally.** `runService.ts:705` destructures it verbatim from the
caller's input and `:1072` inserts it unchanged, guarded by
`.onConflictDoNothing({ target: [aiAgentRuns.orgId, aiAgentRuns.dedupeKey] })` (`:1078`). Each
admission owner mints its own string. The constraint is
`ai_agent_runs_org_dedupe_key_uq UNIQUE (org_id, dedupe_key)`
(`apps/api/migrations/2026-09-02-ai-agents.sql:119-121`), tenant-scoped on purpose, the comment at
`:114-118` notes a global unique index below RLS would leak cross-tenant existence via 23505.
VERIFIED.

| file:line | trigger | admitting event | occurrence identity (`dedupeKey`) | can coexist with task admission for the same occurrence? |
|---|---|---|---|---|
| `services/automationRuntime.ts:1833` (`executeAiTriageAction`) | automation `ai_triage` action | any automation trigger whose action list includes `ai_triage`, managed-agent only | `:1847-1849`, `trigger?.alertId ? \`alert:${trigger.alertId}\` : \`event:${trigger?.eventId ?? context.runId}\`` | **No.** Shares the `alert:<id>` namespace with the anomaly path deliberately. A parallel task admission for the same alert would be a third writer on a key designed for exactly two. Needs the §6.4 routing switch. |
| `services/aiAgents/metricAnomalySubscriber.ts:188` | anomaly incident | `anomaly.incident_opened` | `:184`, `linkedAlertId ? \`alert:${linkedAlertId}\` : \`anomaly:${incident.id}\`` | **No** once promoted to an alert (deliberate collision, `:35-42`); **yes** while unpromoted, where `anomaly:<id>` is unique to this path. Two different identities for one occurrence is itself a sunset hazard. |
| `services/aiAgents/alertVerdictSubscriber.ts:194` (`enqueueVerdictRunForAlert`) | alert verdict | `alert.resolved` (system/auto only) or the delayed `alert.triggered` job (`jobs/alertVerdictScheduler.ts:136, 221`) | `:203`, `` `alert-verdict:${alertId}` `` | **Yes.** Distinct namespace and a distinct `profile` (`verdict`), with its own concurrency caps. A `full` task run and a `verdict` run for one alert are not duplicates. |
| `services/aiAgents/alertVerdictSubscriber.ts:250` (`enqueueVerdictRunForGroup`) | correlation group | `alert.correlation_group.created` | `:260`, `` `group-verdict:${payload.groupId}` `` | **Yes**, same reasoning. |
| `services/aiAgents/ticketHelpdeskSubscriber.ts:303` (`admitTriageRun`) | ticket shadow | `ticket.created`, `ticket.commented` (verified-human only), `ticket.status_changed → resolved` | `:23-38`, `ticket-created:<ticketId>` shared by created and commented (first admitter wins, one triage run per ticket by design); `ticket-resolved:<ticketId>` for the resolved lane | **No** for the ticket-triage recipe: `ticket-created:` is already a "one owner per ticket" key, so a task admission would need to adopt that exact key, not add a second. |
| `jobs/aiAgentSweepScheduler.ts:610` | schedule, narrative profile | fixed-tick `tick` → `occurrence` jobs on the `ai-agent-sweep` queue | `:618`, `` `narrative-${baseline.id}-${orgId}-${occurrenceKey}` `` | **Yes** against other profiles; **no** against a task admission for the same `(schedule, org, occurrence)`. Note the prefix is profile-namespaced on purpose (`:605-609`): a shared `sweep-` prefix would silently drop one of the two. |
| `jobs/aiAgentSweepScheduler.ts:620` | schedule, sweep profile | same | `:628`, `` `sweep-${baseline.id}-${orgId}-${occurrenceKey}` `` | Same as above. |
| *(excluded)* `routes/aiAgents.ts:1737` `POST /:id/runs` | human "run now" | manual, `requireMfa()` | `:1741`, `` `manual:${randomUUID()}` `` | Never dedupes, by design. Not a sunset target. |

**Two candidates named in the plan do not exist.**

- `apps/api/src/jobs/patchSchedulerWorker.ts` contains no reference to `createAndEnqueueAgentRun`,
  `ai_agent_runs`, or any `ai_agent` symbol. VERIFIED negative by grep. The patch scheduler does not
  admit agent runs today.
- Fleet findings (`apps/api/src/jobs/fleetRemediationDispatch.ts`,
  `apps/api/src/services/fleetFindings/`) likewise contain no agent-run admission. VERIFIED
  negative.

So the §6.4 sunset contract test's initial legacy list is **seven** entries, not the nine the plan
implies. Suggested shape, which can only shrink:

```ts
export const LEGACY_TRIGGER_ADMISSION_OWNERS = [
  'automation_ai_triage',        // services/automationRuntime.ts
  'anomaly_incident',            // services/aiAgents/metricAnomalySubscriber.ts
  'alert_verdict',               // services/aiAgents/alertVerdictSubscriber.ts (alert)
  'alert_group_verdict',         // services/aiAgents/alertVerdictSubscriber.ts (group)
  'ticket_shadow',               // services/aiAgents/ticketHelpdeskSubscriber.ts
  'schedule_sweep',              // jobs/aiAgentSweepScheduler.ts
  'schedule_narrative',          // jobs/aiAgentSweepScheduler.ts
] as const;
```

**Durable occurrence identity for cutover.** The three keys a task admission must be able to adopt
rather than duplicate are `alert:<alertId>` (shared by two owners already),
`ticket-created:<ticketId>`, and `<profile>-<baselineId>-<orgId>-<occurrenceKey>`. §6.4's "persist
the selected path and org/source occurrence/recipe identity before either path can create work" maps
onto the existing `(org_id, dedupe_key)` unique constraint directly: the task admission writes the
**same** dedupe key, so the constraint itself is the mutual exclusion. That is a better mechanism
than a routing switch alone, and it is already enforced by the database.

---

## 7. #4178 and #4206 reconciliation

Recorded, not acted on. Neither issue is commented on or closed by this wave.

### 7.1 #4178, anomaly-source trigger

**Issue text** (VERIFIED via `gh issue view 4178`): "Originally the 'anomaly sources' item in #3821
wave 6 (#3828). Folded into phase 2's alert-verdict lane (P2-1), which runs judgement on the
existing deterministic correlator's output. Revisit as its own trigger kind only if the correlator
cannot express a needed signal." Labels `roadmap`, `status:idea`, `priority:p3`. State: OPEN.

**What exists in code.** A separate, shipped `triggerKind: 'anomaly'` admission path. VERIFIED:

- `apps/api/src/services/aiAgents/metricAnomalySubscriber.ts`, registered as `ai-agent-anomaly` in
  `apps/api/src/services/eventSubscribers.ts:80-98`, subscribed to `anomaly.incident_opened`.
- `AI_AGENT_TRIGGER_KINDS = ['alert','manual','schedule','ticket','anomaly']`
  (`packages/shared/src/types/aiAgents.ts:19`). The DB CHECK was originally the four-value list
  (`apps/api/migrations/2026-09-02-ai-agents.sql:106`) and was dropped and re-added to admit
  `'anomaly'` (`apps/api/migrations/2026-09-20-ai-agents-anomaly-pilot.sql:138-140`).
- `ai_agent_runs.anomaly_incident_id` exists with its own index and immutable-guard coverage
  (same migration, `:122-124`).

**Scope differences.**

1. The issue says the work was "folded into" the alert-verdict lane, implying no separate trigger
   kind. The code has a separate subscriber, a separate trigger kind, a dedicated column and its own
   migration. Direct contradiction.
2. The issue is labelled `status:idea` / `priority:p3`; the feature is in shipped code.
3. The issue's spirit is partly right: the anomaly path *does* cross-dedupe onto the alert key space
   once an incident is promoted (`metricAnomalySubscriber.ts:184`), so there is a real coupling to
   the alert path, just not "no separate trigger kind".
4. **NOT CHECKED:** whether anomaly-triggered runs are forced to `shadow` mode in all cases, and
   whether that gating is what the issue would consider "complete coverage". The orchestrator should
   confirm before closing.

### 7.2 #4206, intent-anchored fix watches

**Issue text** (VERIFIED): "Follow-up to #3828 (PR #4168). Policy-decided (wave 5) intents are
excluded from fix-held watches because they carry no post-execution verification. Add release-side
`verification` on the intent path, then admit them to the watch." Labels `enhancement`,
`track:plan`, `ai`. State: OPEN.

**What exists in code.** Built, and the code annotates itself as closing the issue. VERIFIED:

- `apps/api/src/jobs/intentReleaseWorker.ts:425-447`, `watchReleasedIntent`'s header reads "P2-5
  Task 5, #4192, closes #4206", and it opens a verification episode in its own savepoint nested
  inside the terminal CAS's transaction. Called at `:1050`.
- `apps/api/src/services/aiAgents/fixWatch.ts:318`, `createIntentFixWatchRow`.
- `apps/api/src/db/schema/aiAgentFixWatches.ts:19-27` defines
  `AI_AGENT_FIX_WATCH_SOURCE_KINDS = ['act_run','intent']`; the comment at `:47-56` says the
  `intentId` + `sourceKind` + `opKeys` combination "closes #4206". `intent_id` carries a composite
  FK `(intent_id, org_id) → action_intents(id, org_id)` and a partial unique
  `ai_agent_fix_watches_intent_uq` (`:77-87`).
- Intent-anchored watches are graded by the same recovery and recurrence sweep as run-anchored ones
  (`fixWatch.ts:551`).

Watches are anchored **both** ways: `run_id` stays `NOT NULL` (`aiAgentFixWatches.ts:65`) and
`intent_id` is additive.

**Scope differences.**

1. The literal ask appears delivered, and two code sites self-annotate "closes #4206", yet the issue
   is open. This is a tracking delta.
2. The gate is narrower than "policy-decided intents" as a category in one direction and exactly
   right in another: `recordIntentTerminalEvidence` requires `intent.requestingAgentRunId`
   (`intentReleaseWorker.ts:339-341`), and every policy-decided intent is agent-originated by
   construction (`policyDecide.ts:502` treats a missing run id as "structurally impossible").
   So the named category is covered. VERIFIED.
3. **A residual gap the fix does not close.** A watch only opens `if (anchor.alertId)`
   (`intentReleaseWorker.ts:455`). When the originating run has no triggering alert, a
   schedule, sweep, ticket or manual run releasing a policy-decided intent, the code instead
   credits the operation `verified` immediately with no watch at all, on the stated reasoning that
   "an operation no watch will ever look at must not sit un-gradeable forever" (`:436-441`). For
   non-alert-triggered intents, "verification" is therefore a same-instant credit, not a
   post-execution check. That is narrower than the issue's blanket phrasing. **NOT CHECKED** whether
   this was discussed and accepted in the P2-5 plan.
4. This gap matters directly to P3-1: a task-linked service recovery whose run has no `alertId`
   would be credited `verified` on dispatch. The task criterion must not inherit that credit,
   see contradiction C11.

---

## 8. Safe DTO, event, and export projection

### 8.1 The existing pattern, which the Operator must copy

Run DTOs use **named-field mapper functions, never object spread**, plus a type-level tripwire.

- List DTO `mapRunListItem` (`apps/api/src/routes/aiAgents.ts:1021-1065`). The SQL itself never
  selects `outcome`; it extracts `outcome->>'runVerdict'` and a computed count. The comment at
  `:1132-1136` says "the full outcome (which is where the SAFE-projection risk lives) has no
  business leaving Postgres." VERIFIED.
- Detail DTO `buildRunTrace` (`apps/api/src/services/aiAgents/runTrace.ts:359`). The file header
  (`:6-13`) states "SAFE PROJECTION IS THE POINT OF THIS FILE." Mappers: `mapExecuted` (`:201-215`),
  `mapProposed` (`:217-230`, whose docstring notes `action.args` "is intentionally never read
  here"), `mapDenied` (`:232-234`), `mapTicketProposal` (`:300-328`), `mapLedgerRow` /
  `mapIntentRow` (`:338-357`, dropping `toolInput`, `toolOutput`, `approvedBy`, `commandId`,
  `arguments`). VERIFIED.
- Tripwire: `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS = ['args','toolInput','toolOutput','arguments']`
  (`packages/shared/src/types/aiAgentRuns.ts:44`), with the header at `:19-37` arguing the leak is
  "impossible by construction, not just avoided by convention". Enforced by `JSON.stringify`
  substring assertions in `runTrace.test.ts` and `routes/aiAgents.test.ts`. VERIFIED.

**Contract for the Operator.** A task, operation or event DTO is assembled by a named-field mapper;
the Operator adds its own tripwire key list (at minimum `checkpoint`, `criteria`, `args`,
`toolInput`, `toolOutput`, `result`) and asserts it in both a pure-projection test and a route test.

### 8.2 #4181 context, with a correction

Issue #4181 (VERIFIED via `gh issue view 4181`): `GET /admin/tool-executions` serializes raw
`ai_tool_executions.toolInput`; define one redaction contract (secret-bearing tools, PII) and apply
it. Standalone security follow-up.

Code: the route is `apps/api/src/routes/ai.ts:1236-1237`; the `.select()` at `:1348-1364` includes
`toolInput: aiToolExecutions.toolInput` (`:1349`) and the array is returned directly at `:1375-1383`
with **no** sanitizer, even though `summarizePayload` / `sanitizeAuditPayload` exist and are used
elsewhere (`mcpServer.ts:1389-1390`). VERIFIED.

**Correction to the issue's own framing.** The route is not platform-admin-only. Its middleware is
`requireScope('organization','partner','system')` + `requireAiRead`, where
`requireAiRead = requirePermission(PERMISSIONS.ORGS_READ...)` (`ai.ts:129, 1238-1239`). That is a
broad, commonly held permission, org-scoped by `auth.canAccessOrg` (`:1253-1255`). VERIFIED. The
issue's "admin-gated" description understates the exposure. Record this on #4181 rather than in the
Operator's own design.

**Consequence.** §11's rule stands: #4181 is a prerequisite to exposing richer trace content, not
permission to copy raw outputs into task events. The Operator must not reuse this route's auth
pattern as precedent.

### 8.3 Field-level projection rules

| Surface | May contain | Must never contain |
|---|---|---|
| Public task/operation DTO | ids, `workflow_key`/`version`, state, phase, wait reason, `deadline`, `next_wake_at`, bounded `objective` text, target display label, verification verdict, execution reference **ids** | `checkpoint`, `criteria`, any raw model or tool text, `toolInput`/`toolOutput`, `args`, the raw device-command `result` |
| Outbox payload | `{ taskId, orgId, transition }`, ids only, matching every existing writer (`intentService.ts:1604, 1624, 2055`; `decideApprovalRequest.ts:1031`) | anything the consumer could act on without re-reading the row |
| Notification | template-composed title and message, each string passed through a control-character stripper and length bound, as `flattenNotificationLine` does (`apps/api/src/services/aiAgents/runFinishedNotify.ts:250-252`) | model-authored prose, tool output, customer content |

VERIFIED for all three existing precedents.

### 8.4 Export classification for the P3-1 tables

Buckets and helper: `tablePolicy(organizationKey: 'id' | 'org_id', groups: ColumnGroups)`
(`apps/api/src/services/tenantExportPolicyRegistry.ts:17-20`); `ColumnGroups` is
`{ included, reviewedIncluded, excludedSensitive, excludedOpen, specific? }` (`:4-10`). VERIFIED.

The open-container rule is enforced against the **live** `information_schema`, not the hand-written
entry: `OPEN_CONTAINER_TYPES = new Set(['json','jsonb','bytea'])` plus name matches
(`apps/api/src/services/tenantExportPolicy.ts:57-69`), and `buildTenantExportPlan` throws unless
`openContainerReviewed === true` (`:223-228`). So a new jsonb column on a registered table fails the
build. VERIFIED. `SUSPICIOUS_NAME_PARTS` is at `tenantExportPolicy.ts:35-55`.

Precedent to copy verbatim in style, `action_intents` puts `arguments` and `result` in
`excludedOpen` (`tenantExportPolicyRegistry.ts:44`); `ai_agents` puts `tool_allowlist`,
`protected_resources`, `limits`, `triggers`, `recipients`, `act_assets` there (`:78`). VERIFIED.

**`ai_operator_tasks`**

| Column | Bucket | Why |
|---|---|---|
| `id`, `org_id`, `agent_id`, `workflow_config_id`, `parent_task_id`, `successor_of_task_id`, `accounting_root_task_id` | `included` | tenant identifiers |
| `workflow_key`, `workflow_version`, `source_kind`, and each typed source link column | `included` | non-secret identity |
| `origin_user_id`, `requester_user_id`, `human_owner_user_id` | `included` | user identifiers, matching `action_intents.requested_by_user_id` |
| `objective` (`text`) | `included` | customer-visible; §11 requires exportable text to live in bounded `text`, never only inside a container |
| `mode`, `state`, `phase`, `wait_reason`, `outcome` (all `text` + CHECK) | `included` | §11.1 forbids `pgEnum` here |
| `revision`, `lease_epoch`, `budget_cents`, `deadline_at`, `next_wake_at`, `lease_expires_at`, `created_at`, `updated_at` | `included` | monotonic counters and timestamps |
| `frozen_scope`, `frozen_criteria`, `frozen_authority`, `checkpoint` (jsonb) | `excludedOpen` | every jsonb column, without exception. A frozen authority blob is a capability list |

**`ai_operator_operations`**

| Column | Bucket | Why |
|---|---|---|
| `id`, `org_id`, `task_id`, `step_id`, `operation_key`, `attempt_ordinal`, `plan_revision`, `originating_run_id`, `intent_id` | `included` | identifiers |
| `argument_digest` | `included` | precedent: `action_intents.argument_digest` is `included` (`registry:44`) |
| `execution_ref_kind`, `execution_ref_id` | `included` | ids only, per §11.3's export column |
| `dispatch_state`, `result_state`, `verification_state`, timestamps | `included` | text + CHECK |
| `result` (jsonb) | `excludedOpen` | exact precedent: `action_intents.result` |

**`ai_operator_task_outbox`**

| Column | Bucket |
|---|---|
| `id`, `org_id`, `task_id`, `source_kind`, `source_id`, `transition`, `due_at`, `published_at`, `attempts`, `created_at` | `included` |
| any `payload` jsonb | `excludedOpen`, and `payload` is additionally a name-based open container (`tenantExportPolicy.ts:57-69`) |

**`action_intents` new columns**, `task_id`, `task_step_key`, `operation_key` are all `included`.
None matches `SUSPICIOUS_NAME_PARTS`. This entry is mandatory in the P3-1 schema PR (hazard H5).

**`ai_agent_runs` new columns**, `task_id`, `task_step_id`, `task_attempt_ordinal`,
`prompt_version`, `resolved_model` are all `included`.

`ai_operator_task_events` is append-only, so it also goes in `AUDIT_ADMIN_REQUIRED_TABLES`
(spec §11). Its bounded `detail` text is `included`; any jsonb on it is `excludedOpen`.

---

## 9. Move, merge, and site visibility semantics today

### 9.1 Device move

`apps/api/src/routes/devices/moveOrg.ts` (the block around `:584`) is a **loop over a list
constant**, not a per-table switch:

```ts
for (const table of getDeviceOrgDenormalizedTables()) {
  if (DEVICE_ORG_FK_CASCADE_TABLES.includes(table)) continue;
  await tx.execute(
    sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE device_id = ${deviceId}::uuid`,
  );
}
```

VERIFIED. The list is `CORE_DEVICE_ORG_DENORMALIZED_TABLES`
(`apps/api/src/routes/devices/core.ts:232`), read through `getDeviceOrgDenormalizedTables()`
(`:325`), which wraps it with `withExtensionDeviceOrgDenormalized(...)`.
`script_executions` is at `:265`. The device cascade list is `CORE_DEVICE_CASCADE_DELETE_TABLES`
(`:448`, `script_executions` at `:486`), read through `getDeviceCascadeDeleteTables()` (`:544-546`).
VERIFIED.

**Hooks wave W03 must extend:**

1. `ai_operator_task_targets` needs a **detach**, not a restamp: set `detached_at` and a reason,
   fence pending execution, keep the frozen label (§11.3). That is not what the loop above does, so
   it belongs alongside the loop as an explicit step, exactly as the existing `ai_agent_runs`
   handling does, `ai_agent_runs` is deliberately **excluded** from
   `CORE_DEVICE_ORG_DENORMALIZED_TABLES` and its `org_id` is trigger-immutable.
2. The DB trigger `breeze_cascade_device_org_id()` severs lineage on a **direct** `devices.org_id`
   update that bypasses the route (asserted at
   `apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts:656`). Any new
   lineage column needs equivalent trigger coverage or a direct update leaves it stranded.
3. `ai_operator_tasks` and `ai_operator_operations` must be in neither denormalized list, task
   `org_id` is immutable.

### 9.2 Ticket move

`POST /tickets/:id/move-org`, route `apps/api/src/routes/tickets/moveOrg.ts:18-60`, service
`moveTicketOrg` in `apps/api/src/services/ticketService.ts`. Requires `partner`/`system` scope,
`tickets:write` + `organizations:write`, and MFA. VERIFIED. Ticket-bound task targets detach here on
the same contract as device targets.

### 9.3 Org merge

`mergeAiAgents` (`apps/api/src/services/orgMergeCustomExecutors.ts`, around `:735-764`) disables a
loser-org agent that duplicates an active survivor agent of the same `kind`, clears
`supervisedActionKeys` on **every** loser-org agent, then repoints all loser `ai_agents` rows to the
survivor. VERIFIED.

Registry: `CUSTOM_EXECUTORS` (`orgMergeCustomExecutors.ts:1039`), with `CUSTOM_RESOLVE_EXECUTORS`
(`:1074`) for resolve-phase passes and the preview mirrors `CUSTOM_WOULD_REVOKE_COUNTS` (`:1091`) /
`CUSTOM_WOULD_DROP_COUNTS` (`:1113`). Every `CUSTOM_RESOLVE_EXECUTORS` key must also appear in
`CUSTOM_EXECUTORS`. VERIFIED.

**Leave-for-erasure is a disposition, not an omission.** `{ kind: 'leave-for-erasure'; note: string }`
(`apps/api/src/services/orgMergeRegistry.ts:27`). The exact precedent to copy:

```ts
ai_agent_runs: { kind: 'leave-for-erasure', note: 'org_id is trigger-immutable
  (ai_agent_runs_immutable_guard); run history stays with the source org per the
  2026-08-23 owner decision' },
```

`orgMergeRegistry.ts:206`. VERIFIED. Companions: `audit_logs` (`:128`), `action_intents` (`:195`),
`ai_agent_schedules` (`:217`), `ai_agent_fix_watches` (`:224`), `ai_agent_graduation` (`:232`),
`ai_agent_impact_daily` (`:233`).

**W03 must add** `ai_operator_tasks`, `ai_operator_operations`, `ai_operator_task_outbox` (and later
targets, steps, events) as `leave-for-erasure`, plus a custom executor that **fences live loser-org
tasks first**, stop new admissions, record in flight, before the merge proceeds, per §11.3. The
`ai_agents` repoint means the task's `agent_id` will point at a survivor-org agent while the task
keeps its immutable org, which is exactly why §11.3 specifies a plain FK with the same-org check at
admission rather than a composite FK.

### 9.4 Fixtures for W02

`apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts` asserts, VERIFIED:

- `ai_agent_runs.org_id` is immutable even under a dual-org RLS context (`:209`).
- moveOrg's detach statement (`SET deviceId/alertId/sessionId = NULL`) does not trip the composite
  FK `(requesting_agent_run_id, org_id) → ai_agent_runs(id, org_id)` (`:236`).
- Driving the real `POST /devices/:id/move-org`: device, alert and session follow the move; the run
  stays in the source org with its links nulled; the attributed intent is untouched (`:259`).
- The same for `anomaly_incident_id` and the reverse pointer (`:330`).
- #4215: `ticket_id` is detached on device-less ticket runs only (`:622`), and a direct
  `devices.org_id` update severs it via the trigger (`:656`).

Reusable helpers: `orgContext` (`:61`), `expectImmutableViolation` (`:79`), `runValues` (`:92`),
`orgWithAgent` (`:104`), `insertDevice` (`:118`), `insertLineage` (`:139`), `insertAgentIntent`
(`:174`), `seedTicketRunLineage` (`:446`), `expectTicketLineageSevered` (`:568`). W02 extends
`insertLineage` and `seedTicketRunLineage` with a task, a target and an operation rather than
building new fixtures.

### 9.5 Site visibility

Helpers: `allowedSiteIds` (`apps/api/src/middleware/auth.ts:140`), `canAccessSite` /
`siteAccessCheck` (`:198-203`), populated for organization-scope users from
`organizationUsers.siteIds` (`:698-710`). VERIFIED.

**AI agent runs are not site-filtered today.** `GET /runs` (`apps/api/src/routes/aiAgents.ts:1081-1184`)
and `GET /runs/:runId` (`:1198`) build their WHERE from `auth.orgCondition(aiAgentRuns.orgId)` plus
optional filters; there is no `allowedSiteIds` or `canAccessSite` reference anywhere in that route
file. VERIFIED by grep. `routes/devices/core.ts` does gate on them (`:783-798`, `:1611`).

So spec §11's "user-facing site restrictions are enforced on task list/detail/events" is **new
behaviour**, not parity with runs. P3-1's read-only task detail must implement it from scratch,
following the device-list pattern. This is a genuine addition, and the spec should not be read as
describing something that already works.

---

## 10. Scheduler lane and metrics

### 10.1 Lane

`apps/api/src/jobs/scheduleRegistry.ts` header, verbatim:

```
 * MINUTE LANES
 * ------------
 * Minutes are allocated in lanes mod 5, because the *uncontrolled* schedules —
 * the 43 sub-hourly `every:` ticks this registry deliberately does not manage
 * (5s/30s/60s/2m/5m/10m/15m/30m sweeps) plus the every-5-minute and
 * every-10-minute cron ticks —
 * all land on minutes = 0 (mod 5).
 *
 *   = 3 (mod 5)  daily tier — the heavy batched-DELETE retention jobs
 *   = 2 (mod 5)  sub-daily tier — cheap hourly / 6-hourly sweeps
 *   = 0 (mod 5)  left to the unmanaged fine-grained ticks
 *
 * Three legacy sub-daily slots (:00, :15, :35) predate the lanes and are not
 * worth churning; they are collision-checked like everything else.
```

`COARSE_REPEAT_INTERVAL_MS = 60 * 60 * 1000` at `:69`. VERIFIED.

Occupied minutes across every registration in `JOB_SCHEDULES` (`:81-160`), VERIFIED by extracting
the minute field of every cron expression: `0 3 7 8 12 13 15 17 18 22 23 27 28 32 33 35 37 38 42 43
47 48 52 53 57 58`, plus `30` and `45` from `partner-trust-promote`'s `*/15`.

**Claim for the hourly reconciler: minute `:02`, i.e. `'2 * * * *'`.** It is the only free minute in
the =2 (mod 5) sub-daily lane, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52 and 57 are all taken. VERIFIED
by intersecting the lane with the occupancy list. The =0 (mod 5) minutes are reserved by the header
for unmanaged ticks even where they read as free; the =3 (mod 5) lane is the daily heavy-delete
tier. Re-run `scheduleRegistry.contract.test.ts` when the entry is added, since the registry moves.

The coordinator (proposed 15 s) and outbox publisher (proposed 5 s) stay **outside** the registry,
both are below `COARSE_REPEAT_INTERVAL_MS`, which is what §11.2 and the header already require.
No bare `every: 24h`.

### 10.2 Metrics

`apps/api/src/services/metricsRegistry.ts` is a 37-line leaf module holding one singleton,
`export const metricsRegistry = new Registry();` (`:37`), deliberately import-isolated from routes,
db and services so the worker role can serve `/metrics` without loading the route graph, enforced
by `apps/api/src/services/workerEntrypointClosure.contract.test.ts`. VERIFIED.

There is no registration wrapper. The convention is a module-scope `new Counter/Gauge/Histogram`
ending in `registers: [register]`, where `const register = metricsRegistry`
(`apps/api/src/routes/metrics.ts:102`):

```ts
const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register]
});

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests by method, matched route template, and response class',
  labelNames: ['method', 'route', 'status_class'] as const,
  registers: [register]
});
```

`routes/metrics.ts:158-162` and `:143-149`. VERIFIED. Naming is `snake_case`, product series
prefixed `breeze_`, Counters suffixed `_total`, Histograms `_seconds` with explicit buckets.

Spec §11.2's eight metrics, typed:

| Metric | prom-client type | Note |
|---|---|---|
| `ai_operator_tasks_by_state` | **Gauge**, label `state` | point-in-time census |
| `ai_operator_waiting_age_seconds_max` | **Gauge** | a max, not a distribution; a Histogram would not answer "is anything stuck" |
| `ai_operator_outbox_unpublished` | **Gauge** | queue depth |
| `ai_operator_outbox_oldest_age_seconds` | **Gauge** | staleness |
| `ai_operator_lease_reclaims_total` | **Counter** | `_total` suffix already correct |
| `ai_operator_unknown_effect_handoffs_total` | **Counter** | |
| `ai_operator_dispatch_claim_conflicts_total` | **Counter** | |
| `ai_operator_reconciler_scan_rows` | **Histogram**, `_rows` | a per-pass distribution; if a running total is wanted instead, rename to `_total` and make it a Counter, do not leave the name and the type disagreeing |

Note none of the eight carries the `breeze_` prefix the product series otherwise uses. Either add it
consistently (`breeze_ai_operator_*`) or record the exception deliberately; do not do half of each.

---

## 11. Contradictions

Input to the next revision of the spec and plan. Neither document is edited by this wave.

**C1, the patch scheduler admits no agent runs.** The plan's P3-0 bullet names "patch scheduler
occurrences (`apps/api/src/jobs/patchSchedulerWorker.ts`)" as a legacy admission owner. That file
contains no `createAndEnqueueAgentRun`, no `ai_agent_runs` reference and no `ai_agent` symbol.
VERIFIED negative. Spec §6.4's paragraph about patch scheduler occurrences producing or adopting a
task/job lineage describes future work, not a current second owner.

**C2, fleet findings admit no agent runs.** Same as C1 for
`apps/api/src/jobs/fleetRemediationDispatch.ts` and `apps/api/src/services/fleetFindings/`.
VERIFIED negative. The sunset list is seven entries, not nine (§6).

**C3, `dedupeKey` is not computed at `runService.ts:1074`.** The plan asks to "cite how
`runService.ts` around 1074 computes it". It does not compute it: `:705` destructures it from the
caller's input and `:1072` inserts it verbatim. Each admission owner mints its own string (§6). The
correct citations are the seven call sites plus the constraint
`ai_agent_runs_org_dedupe_key_uq` (`apps/api/migrations/2026-09-02-ai-agents.sql:119-121`).

**C4, `manage_services`'s `executeCommand` call is at `aiToolsScripts.ts:660`, not `:649`.** Spec
§2 and §6.5 both cite `:649`. At the baseline commit that line is
`const { executeCommand } = await getCommandQueue();`, the destructured import of the function, not
a call to it. The call is `:660-664`. VERIFIED.

**C5, the outbox event values are at `actionIntents.ts:92-99`, not `:449`.** Spec §2 cites `:449`
for "`event_type`, values …"; `:449` is the column declaration
(`eventType: text('event_type').notNull().$type<IntentOutboxEvent>()`) and the values live in
`intentOutboxEventEnum` at `:92-99`. The spec also omits `intent_created` and
`pam.desired_state_changed` from its list. The substantive claim, no completed or failed event,
is **correct**. VERIFIED.

**C6, the proposed second partial unique index is unsafe as written.** §6.5 specifies "a partial
unique index on `(org_id, task_id, operation_key)` over live statuses" *in addition to* the existing
`(org_id, idempotency_key)` index. A single `ON CONFLICT` clause arbitrates one index; a collision
on the unnamed one raises a bare 23505 through a code path that expects an idempotent replay
(`intentService.ts:1476-1486`). Derive the task-linked `idempotency_key` from task identity instead,
so the existing index is the single arbiter (§5.3, H1). This changes §6.5's mechanism, not its
intent.

**C7, a live-only predicate cannot guard sequential replay.** §6.5 relies on the partial unique to
stop "a continuation run re-proposing the same operation" minting a second intent. `completed` and
`failed` leave `LIVE_INTENT_STATUSES` (`intentService.ts:55`), and for the thin slice the intent
completes when the 30-second tool wait returns, which can be minutes before the device finishes
(§2.6). The permanent `ai_operator_operations` uniqueness is the sequential guard; the intent index
is only the concurrent one. The spec should say which does which.

**C8, the same-task relaxation crosses a documented invariant and needs a paired recheck.**
`intentService.ts:1182-1185` ties run scoping to the release path evaluating the originating run's
immutable policy snapshot. Relaxing `:1527` for same-task runs means a later run can release under
an earlier run's snapshot, which spec §7.1's "tightening takes effect immediately" forbids. The
relaxation must ship with a live-authority recheck at the dispatch claim (§5.3, H3).

**C9, there is no "fresh within N minutes" parameter today.** The plan's recipe-card bullet asks
for "service state plus the triggering alert or health condition, fresh within N minutes; cite where
each comes from". `VERIFY_READ_TIMEOUT_MS = 8_000` (`actVerify.ts:75`) is a read deadline and
`FIX_HOLD_MINUTES = 60` (`fixWatch.ts:66`) is a recurrence hold. Neither is a freshness bound. P3-1
must introduce one or state the hold as the contract (§2.7).

**C10, the agent's restart success is not proof the service runs, and macOS is weakest.** Only the
Windows path waits for `svc.Running` (`services_windows.go:132`); Linux relies on `systemctl`'s exit
code; macOS discards the stop error entirely (`services_darwin.go:128-130`). §4's "service state and
the triggering health condition recover with fresh evidence" is achievable only through the
independent `list_services` read, never the dispatch result (§2.1).

**C11, the existing fix-watch eligibility gate does not fire for a supervised task run.**
`isFixWatchEligible` requires `run.modeAtStart === 'act'` (`fixWatch.ts:133-139`), and P3-1 is
supervised-only by design (plan P3-1, "supervised mode only"). Separately, `watchReleasedIntent`
credits `verified` immediately when the run has no `alertId` (`intentReleaseWorker.ts:436-441,
455`). So reusing the existing verification path unchanged would either open no watch or
auto-credit. §6.5's "reuse `actVerify`/`fixWatch` evidence" needs an explicit statement of which
gate the task path uses.

**C12, #4178 is shipped, not deferred.** The Phase 2 spec §11 lists the anomaly-source trigger as
deferred and "subsumed by verdicts on correlator output", and #4178 is labelled `status:idea`. A
separate `triggerKind: 'anomaly'` subscriber, trigger-kind CHECK and `anomaly_incident_id` column
are all in shipped code (§7.1). The new plan's "Spec/code indicate the trigger already exists" is
right; the Phase 2 spec is the document that is wrong.

**C13, #4206 is implemented with a residual gap the plan does not name.** Two code sites annotate
themselves "closes #4206" (`intentReleaseWorker.ts:425-427`, `aiAgentFixWatches.ts:47-56`), yet the
issue is open. The gap is not the policy-decided category, which is covered, but the non-alert
anchored case, which is credited `verified` on release with no watch (§7.2). The plan's "verify
intent-anchored watches end to end and close or re-scope" should name that case explicitly.

**C14, `/admin/tool-executions` is not admin-gated.** #4181 and the Phase 2 spec both describe it
as exposing raw `toolInput` "to platform admins". Its actual gate is `requireAiRead` =
`requirePermission(ORGS_READ)` (`ai.ts:129, 1238-1239`). The exposure is wider than the issue
records (§8.2).

**C15. AI agent runs are not site-filtered, so §11's site restriction is new work.** No
`allowedSiteIds` / `canAccessSite` reference exists in `routes/aiAgents.ts` (VERIFIED by grep),
while `routes/devices/core.ts` does gate on them. §11 reads as though task site restriction extends
an existing behaviour; it does not (§9.5).

**C16, the newest committed migration is `2026-10-13-110000`, not `2026-10-13-…` generically.**
Spec §11 says "the newest shipped migration is named `2026-10-13-…`". The exact newest by
`localeCompare` is `2026-10-13-110000-scripts-security-acknowledgement.sql`, and three files share
the `2026-10-13` date (`-100000-device-commands-deliver-by`, `-100100-action-intents-ticket-delete-tombstone`,
`-100100-partners-service-management-mode`). VERIFIED by listing. P3-1's migration must sort after
`2026-10-13-110000`, and the pre-push hook re-checks against `origin/main`, so re-verify at push
time.

**C17, there is no run-level cancel, so a task cancel cannot stop a running run.** `cancelled` and
`expired` are valid `ai_agent_runs` statuses with **zero** production writers, and no cancel-run
route exists (§3.1, VERIFIED by enumerating every `transitionRunStatus` call site). §7.3's
cancellation contract composes with intent cancel and the dispatch claim, but it has no run-level
counterpart to compose with. The spec should state that a cancelled task's in-flight run is fenced
and left to finish, not cancelled.

**C18, two intent terminal writers publish nothing and are reachable by a task-linked intent.**
`routes/approvals.ts:992-994` writes `rejected` with no outbox row of any kind, and
`reapStaleExecutingIntents` writes `failed:execution_lost` with no outbox row (§3.2). P3-1's
"terminal publication" bullet names "the release worker and expiry reaper (the two writers this
recipe needs)", the report-suspicious path is a third, and a rejected task operation that publishes
nothing would strand the task in `waiting` until its deadline. Add it to the PR (3) scope.

**C19, the Phase 2 spec's `effectivePolicy.ts:199` citation for the partner/org intersection is
stale.** At this baseline `:199` is an unrelated `pick` helper. The intersection is
`intersectToolRefs(partner.actAssets.supervisedActionKeys ?? [], ...)` at `:297-299`, and the
"no org row means `[]`" rule is at `:191-192`. VERIFIED. Recorded because §2.3 of this document
depends on the fact, and because it shows Phase 2 spec citations should be re-read, not trusted,
when P3 waves quote them.

**C20, the task outbox diverges from the outbox precedent the spec cites, and that is worth stating
on purpose.** §11.1 points at `intent_outbox_unpublished_idx` as the model for
`ai_operator_task_outbox`'s partial index, and the index shape does carry over. But `intent_outbox`
is itself **`INTENTIONAL_UNSCOPED`** — listed alongside `device_commands` at
`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:89` as a "system-scoped
workers-only queue" whose parent FK cascades from an already-RLS-forced table. §11 nonetheless
specifies `ai_operator_task_outbox` as shape 1 with `org_id` and full RLS. VERIFIED. That is
defensible, since a task outbox row is read by a coordinator that must respect tenancy rather than
by the agent WS path, but it makes the new table the first RLS-scoped outbox in the repository. P3-1
should say so explicitly rather than let a reviewer read "same shape as `intent_outbox`" and expect
an unscoped table, and the RLS-coverage allowlist must **not** gain a new entry for it.

**Non-contradictions, confirmed as written.** Spec §2's claims about `finishRun` publishing after
the write (`runLoop.ts:1898` then `:1916`), the reaper's `failed:execution_lost`
(`intentExpiryReaper.ts:274-276`), the losing CAS discarding the result
(`intentReleaseWorker.ts:1053-1068`), cancel covering only `pending_approval` and `approved`
(`intentService.ts:2043-2048`), the release claim at `:676`, the kill-switch reversal at `:139`, the
run-scoped default key at `:1182`, the live-only partial unique at `:1476`, and the reuse rejection
at `:1527` are all **VERIFIED correct**.

---

## Appendix: what W02 and P3-1 inherit

- **W02 fixtures**: extend `insertLineage` and `seedTicketRunLineage` in
  `agentRunMoveSemantics.integration.test.ts` (§9.4). Reuse
  `deviceEventsFeedIndexes.integration.test.ts` as the EXPLAIN-as-`breeze_app` harness, **NOT
  CHECKED** for reusability in this wave; W02 must confirm before extracting.
- **P3-1 schema PR must include**, in the same PR: the three `action_intents` export-policy entries
  (H5), the five `ai_agent_runs` entries, `CORE_ORG_CASCADE_DELETE_ORDER` registration for all three
  new tables, `leave-for-erasure` dispositions plus a fencing custom executor (§9.3), and the
  §11.1 indexes.
- **P3-1 identity PR must include** the task-derived idempotency key (C6), the same-task relaxation
  with a live-authority recheck (C8), and the operation row's permanent uniqueness (C7).
- **W05's contract test** enumerates the writers in §3 and asserts each publishes what §3 says it
  publishes, including the two that publish nothing.
