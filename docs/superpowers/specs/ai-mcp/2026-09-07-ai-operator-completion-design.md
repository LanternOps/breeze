---
title: AI Operator completion — durable tasks, verified workflows, and fleet execution
date: 2026-09-07
status: draft for product and engineering review
baseline_commit: f21585b839
scope: apps/api, apps/web, packages/shared, existing patch/remediation/ticket services
---

# AI Operator completion

## Summary

- **Problem:** a run is one bounded reasoning attempt. When an approval lands tomorrow, a device answers in an hour, or a worker restarts, nothing owns the task. Phase 2 left fleet, patch, ticket, memory, and impact work on the roadmap (#4173–#4183) for the same reason.
- **Proposal:** add a durable **task** above runs, owned by a Postgres-backed coordinator. A task freezes scope and authority at admission, waits without holding a process, wakes on authoritative results through a transactional outbox, verifies the outcome with a typed adapter, and either completes, hands off, or stops. Runs, intents, and domain executors stay authoritative for what they already own.
- **Four facts are never conflated:** dispatch accepted, domain operation finished, task criterion verified, recurrence observed (§6.5). No exactly-once claim is made for external effects (§6.5, §7.3).
- **Delivery:** Phase 3 proves one single-device recipe end to end with a thin vertical slice first (plan P3-1), then completes the task model, continuation, verification, trials, and the Operator workspace. Phase 4 adds bounded fleet coordination, scheduled-finding child tasks, and patch maintenance. Five independently gated tracks (tickets, memory, measurement, approval access, automatic promotion) run alongside Phase 4.
- **Tenancy:** eight new tables, all shape 1 or the existing dual-owner shape, with composite same-org and same-task FKs, RLS in the creating migration, and cascade/export/merge/move registration in the same wave (§11). History stays in the source org.
- **Operations:** every polled table has a partial index designed around leakproof predicates, pollers register on a `scheduleRegistry` lane, and the coordinator exports stuck-task, outbox-backlog, lease-reclaim, and unknown-effect metrics before any recipe is enabled (§11.1, §11.2).
- **Gates:** each recipe ships behind its own flag with at least 50 evaluated cases, zero false verified-success labels, and zero unauthorized or duplicate effects; fleet widening and customer sending additionally need one enrolled real partner and two weeks of use (§13).
- **Not in scope:** arbitrary user-authored tools, unrestricted prompts, agent-to-agent messaging, autonomous financial sending, and automatic promotion as a prerequisite for "Operator built in" (§2.1, §8.3).
- **Status:** draft. Review history in §14. Register the feature (`register_feature`) on approval; no issues have been created.

## 1. Outcome and scope

Breeze's Operator should accept a supported IT task, investigate it, execute permitted work, wait for decisions or device results, verify the requested outcome, and either finish or hand it to a technician with useful evidence. A browser closing, a worker restarting, or an approval arriving tomorrow must not discard responsibility for the task.

This is a proposed continuation of the existing AI-agent program, requested by Todd on 2026-09-07. It includes the product/architecture review's recommendations as well as the existing roadmap. It is not an approval record, an implementation claim, or authorization to enable new autonomous operations in production.

The program completes three product capabilities:

1. **Delegated operations:** persistent tasks, understandable progress, approval continuation, verified completion, and explicit human handoff.
2. **Repeatable operations:** supported workflows for incident remediation, scheduled findings, patch maintenance, and service-desk work, with bounded fleet execution.
3. **Supervised improvement:** scoped operational memory, evaluated feedback, accurate impact accounting, and convenient approval surfaces.

“Complete” means the supported workflows pass the acceptance and release gates in this document. It does not mean arbitrary requests, every tool in Breeze, every OS, or every third-party integration becomes autonomous.

Related documents:

- [Phase 1 program](2026-08-22-ai-agents-program-and-wave1-design.md).
- [Phase 2 intelligence layer](2026-08-28-ai-agents-phase2-intelligence-layer-design.md), especially §11.
- [Agent builder](2026-09-06-ai-agent-builder-design.md).
- [Delivery plan](../../plans/ai-mcp/2026-09-07-ai-operator-completion.md).

## 2. Current implementation and design changes

Verified against the baseline commit above; issue states were checked on GitHub on 2026-09-07. Citations were re-checked on origin/main b3d528d869 the same day; the 16 commits since the baseline touch no docs or migrations. Phase 1 (#3821), Phase 2 (#4187 and #4188–#4193), and the builder (#5048) are closed. The P3-0a baseline (#5214, [2026-09-07-ai-operator-p3-0-baseline-contracts.md](2026-09-07-ai-operator-p3-0-baseline-contracts.md)) re-verified this section at `89b059f12f` and recorded 20 contradictions; the consequential ones are folded in below and marked with their C-number. Old “awaiting review” headers and unchecked task boxes are not reliable indicators of remaining work.

| Existing fact | Evidence in the repository | Consequence |
|---|---|---|
| A run is a bounded reasoning attempt; approved intents release separately without continuing it | apps/api/src/services/aiAgents/runLoop.ts, executeAgentRun | Add a task above runs; preserve old run semantics |
| Manual run input is deviceId only | packages/shared/src/validators/aiAgents.ts, triggerAgentRunSchema | Add a task API with objective, supported workflow, targets, and criteria |
| Agents are one live row per owner/kind: triage, patch, helpdesk | apps/api/src/db/schema/aiAgents.ts | Keep these as policy-governed workers; allow many workflows per worker |
| The builder preview calculates policy outcomes without executing an investigation | apps/api/src/services/aiAgents/agentPreview.ts | Add a separate, persisted investigation trial |
| Run details distinguish lifecycle, operational verdict, and verification | apps/web/src/components/aiAgents/RunDetailPage.tsx | Reuse evidence presentation; do not discard these distinctions |
| Free-form Tier-2 proposals in full runs do not create approval objects | apps/api/src/services/aiAgents/runLoop.ts, recordProposal | Supported task operations need a uniform actionable proposal contract |
| The intent outbox has decision events, but no durable completed/failed event | apps/api/src/db/schema/actionIntents.ts:92-99 (`intentOutboxEventEnum`: `intent_created`, `intent_approved`, `intent_rejected`, `intent_expired`, `intent_cancelled`, `pam.desired_state_changed`; column at :449); no writer emits a completed or failed event | Add reliable terminal-result signals and reconciliation |
| Run completion events publish after the DB write, not inside it | apps/api/src/services/aiAgents/runLoop.ts:1898-1916 (`finishRun`: `transitionRunStatus`, then `safePublish`) | Existing event delivery alone cannot guarantee continuation |
| A completed tool can return an asynchronous execution handle | apps/api/src/services/aiToolsScripts.ts; apps/api/src/jobs/patchJobExecutor.ts | Observe domain completion before verifying the task |
| Device moves retain AI-run history in the source org and sever device lineage | apps/api/src/__tests__/integration/agentRunMoveSemantics.integration.test.ts | Task history must also stay in its original org |
| Built-in playbooks have an actual deterministic act executor | apps/api/src/services/aiAgents/playbookActExecutor.ts | Reuse it; ordinary/custom playbook tool behavior is not equivalent |
| Scoped sweep proposals are always human-required | apps/api/src/services/actionIntents/intentService.ts:519 (`if (args.hasScope) return 'human_required'`) | Unattended child execution (#4442) needs a typed admission path, not removal of this rule |
| The generic deployment engine is not a working fleet orchestrator | apps/api/src/routes/deployments.ts:65 (status enum has no `paused` or `running`); apps/api/src/services/deploymentEngine.ts:503-518 writes both; `shouldPauseDeployment` (:399) has no production caller | Do not reuse it for fleet coordination without the readiness audit in §9.2 |
| Agent policy snapshots are versioned | packages/shared/src/types/aiAgents.ts:433 (`AI_AGENT_POLICY_SNAPSHOT_VERSION = 9`); limits in packages/shared/src/validators/aiAgents.ts:33 (`limitsFields`) | Task limits are a v10 snapshot with compatible readers (§7.2) |
| No prompt or model version is recorded per run | no `prompt_version` in services/aiAgents or db/schema/aiAgents.ts | Record it per task-linked run (§6.2); pin at admission once T2 versions prompts |
| Existing outboxes poll a partial index | migrations 2026-07-18-action-intents.sql:163 (`intent_outbox … WHERE published_at IS NULL`), 2026-09-19-ai-agents-ticket-shadow.sql:96 | Same shape for the task outbox (§11.1) |
| `scheduleRegistry` manages hourly-and-coarser repeatables only; sub-hourly `every:` ticks are deliberately outside it | apps/api/src/jobs/scheduleRegistry.ts:29, :68 (`COARSE_REPEAT_INTERVAL_MS = 1h`) | Sub-hourly coordinator/publisher ticks use short `every:` intervals; hourly and daily sweeps register on a lane; never a bare `every: 24h` (§11.2) |
| Intent idempotency is run-scoped and live-only | apps/api/src/services/actionIntents/intentService.ts:1182 (default key is run-scoped), :1476 (partial unique covers live statuses only), :1527 (an explicit key reused by another run is rejected) | A continuation run re-proposing the same operation would mint a second intent. Task-scoped operation identity is reserved on the intent at creation (§6.5), in P3-1 |
| Late results are discarded today | apps/api/src/jobs/intentExpiryReaper.ts:275 (`failed:execution_lost` where `executing` and `executed_at IS NULL`); apps/api/src/jobs/intentReleaseWorker.ts:1054 (a worker that loses the `executing → completed` CAS after the tool ran discards the result) | Operation rows persist the execution reference and result independently of the intent CAS (§6.3, §6.5) |
| The intent dispatch claim already exists | apps/api/src/jobs/intentReleaseWorker.ts:676 (`approved → executing` CAS with `requireNotExpired: 'release'`), :139 (kill switch reverts `executing → approved`); apps/api/src/services/actionIntents/intentService.ts:2044 (cancel covers only `pending_approval` and `approved`) | The task dispatch claim extends this CAS and these two paths; it is not a second claim (§7.3) |
| Service restart is a device command, not a script execution | apps/api/src/services/aiToolsScripts.ts:660-664 (`executeCommand(... 'restart_service' ...)`; `:649` is the import) | The thin slice's execution reference is the device command id; the result is observed from command completion (§6.5, plan P3-1) |
| `script_executions` and `ai_agents` rows change org | apps/api/src/routes/devices/core.ts:265 (`script_executions` is device-denormalized and restamped by routes/devices/moveOrg.ts:584); apps/api/src/services/orgMergeCustomExecutors.ts:764 (`ai_agents` repointed to the survivor) | Execution references and the task → agent link cannot be same-org composite FKs (§11.3) |
| The model actually used can differ from the configured one | apps/api/src/services/aiAgents/runService.ts:1074 (`policySnapshot` on the run); apps/api/src/services/aiAgents/runLoop.ts:1294 (`effective.model ?? llm.model`) | Record the resolved model and the prompt version per task-linked run (§6.2) |

The review's main additions are first-class tasks, continuation after results, task-level success criteria, actionable task supervision, trial execution, and workflow capability discovery. Fleet execution, patching, customer replies, memory, and impact improvements were already recognized in the roadmap.

### 2.1 Amendments to earlier decisions

- “No continuation of a headless run” remains true for an individual run. A task now creates a **new** run from a durable checkpoint when further reasoning is needed.
- Prior-run memory becomes an explicit, tenant-scoped feature under #4183. It remains context, never authority.
- Keep the original exclusion of arbitrary user-authored tools, unrestricted system prompts, and agent-to-agent messaging. Deterministic workflow coordination is sufficient for this program.
- The builder's deferred “describe what you want” becomes supported task intake: text resolves to an implemented workflow and validated inputs. It does not generate executable workflow code.
- Task adoption does not implicitly enable act mode, policy-decide, customer communication, fleet changes, or automatic promotion.

## 3. Product model

| Concept | Definition | Persistence/ownership |
|---|---|---|
| Operator | The product surface that accepts and supervises work | No new security principal |
| Agent | A named worker and its policy | Existing ai_agents, partner baseline plus tighter org override |
| Workflow | A versioned, supported procedure with inputs, permitted steps, verification, and escalation | Code-owned recipe plus saved partner/org configuration |
| Task | One accepted objective for one organization and a frozen target set | New ai_operator_tasks |
| Run | One bounded reasoning attempt advancing a task step | Existing ai_agent_runs, with additive task linkage |
| Operation | One logical side effect with stable identity and result references | New ai_operator_operations; existing act/intent/domain execution remains authoritative |

“Recipe” is the user-facing name for a supported workflow, not another database entity. A ticket/alert/fleet finding remains the business record; its linked Operator task stores execution responsibility. Do not create a second ticket queue.

An agent may serve several named workflows, such as “Workstation disk recovery” and “Server service recovery,” with different validated inputs and narrower targets. Preserve agent-kind uniqueness; do not multiply policy rows to create workflow names.

One task always belongs to one org. The partner view aggregates tasks under existing access rules. A partner-wide schedule creates independent org tasks; it never creates a cross-tenant executable task.

**Two configuration surfaces, one precedence rule.** The agent's policy (`ai_agents`, including the task limits added in §7.2) says what the worker may ever do. A workflow configuration (`ai_operator_workflows`) says when to do it and on what scope. Workflow configuration can only narrow the effective agent policy; it never adds an operation, a target class, a budget, or an autonomy level the policy does not already permit, and the server recomputes the intersection at admission and before every dispatch. The agent builder (#5048) creates and edits agents; the Operator creates and supervises tasks. The builder's policy preview stays a static calculation and links to "Run a trial" (§5.3) rather than growing an investigation of its own.

## 4. Supported workflows and what “done” means

Workflows are released individually. Only workflows with a working execution adapter, verification adapter, policy mapping, cancellation behavior, and acceptance suite appear as executable.

| Workflow | Accepted scope and procedure | Required result |
|---|---|---|
| Investigate a device or alert | Read permitted context, identify likely cause, collect evidence, recommend a supported next step | Investigation complete, with uncertainty and an actionable recommendation; never labeled fixed |
| Recover a supported service incident | Diagnose one service incident; use an existing permitted restart or reviewed built-in playbook; observe result | Service state and the triggering health condition recover with fresh evidence |
| Recover disk capacity | Establish disk/volume baseline; preview approved cleanup; execute pinned cleanup; remeasure | The affected volume meets the task's approved free-space/usage criterion |
| Resolve a scheduled finding | Turn a qualifying sweep finding into a device-bound task using one supported remediation recipe | Per-device criterion passes or a named exception is handed off |
| Patch an approved device cohort | Snapshot eligible updates and targets; canary; patch through existing jobs; respect reboot policy; verify; widen | Each target is verified compliant, explicitly deferred, skipped, failed, or unresolved; no hidden remainder |
| Work a supported helpdesk ticket | Triage; collect bounded missing information; link an authorized device; invoke a supported remediation subtask; draft/approve/send response; verify or escalate | Clear resolution evidence and a correct ticket outcome; customer confirmation where required |
| Produce an operations report | Existing narrative/report profile with delivery ownership | Artifact exists and requested delivery succeeds, or delivery failure is actionable |

An unsupported task produces an explanation and supported alternatives before admission. The model must not improvise unrestricted shell workflows or silently reinterpret a request into a different objective.

For customer-reported symptoms without an objective endpoint signal, resolution requires the workflow's customer confirmation or an explicit human decision. No response is not proof of resolution.

## 5. Task intake and Operator workspace

### 5.1 Intake

Entry points: Operator home, device, alert, fleet finding, ticket, or an explicitly requested handoff from interactive AI chat.

1. Choose a workflow or describe the objective.
2. Choose one explicit organization and authorized targets. Existing business-record context pre-fills these values.
3. Review recipe-provided success criteria, applicable limits, and missing setup.
4. Review permitted actions, expected approval boundaries, verification, deadline, cost ceiling, and human owner.
5. Start a trial or start the task.

Free-text interpretation returns a typed draft only. The server resolves real entity IDs, rejects unsupported operations, validates scope, and recomputes readiness. It never accepts an LLM-produced permission verdict. Starting the reviewed task is explicit; automatic triggers use a previously enabled workflow configuration.

Use existing ai_agents:read for task inspection and ai_agents:write plus MFA for interactive launch, retry, resume, pause, cancellation, and handoff. Workflow/policy management retains current partner-management restrictions. Approval decisions retain their existing independent RBAC, MFA, four-eyes, expiry, and revalidation requirements. Do not grant write access through a read-only task view.

Manual delegation captures the requester's authorized org/site/target ceiling and rechecks current access before each new effect. Loss of that access pauses delegated execution. Reassigning the human owner transfers responsibility only: renewed execution requires a reviewed successor task under the new requester's authority, with the prior operation references retained. Automatic tasks are attributed to the enabled workflow policy, not the workflow creator's current login session; their authority is the live policy. These origins are explicit and are never silently converted into each other.

Changing global organization context while drafting cannot retarget the task. “All organizations” is an overview, not an executable target.

### 5.2 Workspace

Add /operator and /operator/tasks/:taskId:

- **Needs your attention:** approvals, questions, failed verification, partial results, and handoffs.
- **Working:** queued, investigating, executing, waiting for devices/windows, and verifying.
- **Recently finished:** objective, outcome, evidence, affected targets, and actual model spend.
- **Give Operator a task:** available workflows, setup requirements, and investigation trial.

Task detail leads with objective, targets, owner, current phase, and the next required action. Show the approved plan and changes, per-target outcome, evidence, linked runs, pending/in-flight operations, and spend below it.

Support answering a bounded question, approving through the existing ceremony, pausing, stopping future work, safe retry, and assigning a technician. Handoff includes findings, changes made, unresolved questions, verification, in-flight effects, and suggested next steps. Human assignment and machine stop are separate visible facts.

Keep /workspace, /fleet, /settings/ai-agents, /ai-agents/runs, /ai-agents/impact, and /approvals functional. Preserve existing fragments, including #agent=<id>. Use hash state for transient filters/selections. Reuse runAction for every web mutation, existing org-scope loading/error states, and current localization catalogs.

Approval DTOs gain safe task/run provenance and an exact intent deep link (#4461). Inline decisions reuse the current approval services and ceremony; do not reuse a chat component's local timeout as a durable approval deadline.

Attention is durably delivered through the task outbox and existing notification infrastructure. Questions, handoffs, terminal failures, failed verification, and approaching deadlines notify the assigned authorized owner; configured team/recipient fallback applies if that owner is unavailable. Dedupe by task/transition/recipient, recheck membership at delivery, and link to the exact task/action. Record delivery failures and show unassigned or undelivered attention in the workspace. A missing eligible recipient produces a visible blocked condition; it cannot silently satisfy handoff. Reuse intent notification delivery rather than notifying twice for the same approval. Notify once on final outcome and separately on later recurrence.

### 5.3 Real trial

A trial performs permitted investigation against a chosen real record, persists findings/proposals, and reports actual model cost. It does not modify standing policy.

Enforcement prohibits operational mutations, executable approval requests, customer messages, mutating child tasks, and autonomous follow-on work. Trial metadata and diagnostics are recorded normally. A trial cannot earn remediation, graduation, or realized-value credit. Its only terminal success label is “Trial complete.”

Trial limits intersect with the live policy. Choosing “Start task from trial” creates a new task, re-resolves authority and evidence freshness, and requires a reviewed launch; it never promotes the trial in place.

## 6. Task lifecycle and durable continuation

### 6.1 State contract

~~~mermaid
stateDiagram-v2
  [*] --> queued: admitted; scope, authority, criteria frozen
  queued --> running: coordinator claims lease
  running --> waiting: typed wait (approval, information, execution, device, maintenance_window, verification_window)
  waiting --> running: dependency satisfied via outbox or reconciler
  running --> paused: pause
  waiting --> paused: pause
  paused --> running: resume; authority rechecked, approvals not extended
  running --> stopping: cancel, expiry, handoff, authority loss
  waiting --> stopping: cancel, expiry, handoff, authority loss
  paused --> stopping: cancel, expiry
  stopping --> cancelled: in-flight reconciled or recorded unknown
  stopping --> expired: deadline passed, in-flight reconciled
  stopping --> handed_off: owner named, package written
  running --> completed: all criteria verified
  running --> partial: some scope verified, remainder explicit
  running --> handed_off: unresolved, evidence packaged
  running --> failed: classified reason
  completed --> [*]
  partial --> [*]
  handed_off --> [*]
  cancelled --> [*]
  failed --> [*]
  expired --> [*]
~~~

While `running`, the phase is one of investigate, plan, execute, verify, document. A `waiting` row carries a typed reason, the dependency it waits on, its deadline, and `next_wake_at`. Terminal states never transition again; "retry" is a linked successor task (below). Lease and fencing rules are in §6.2, dispatch claims in §7.3.

| State/outcome | Meaning |
|---|---|
| completed + verified_resolved | All remediation criteria passed on the accepted target scope |
| completed + investigation_complete/report_delivered/no_action_needed | The specified non-remediation deliverable is satisfied; not counted as a fix |
| completed + trial_complete | Investigation trial finished; no operational effects |
| partial | Some scope finished, remaining scope is explicit and owned |
| handed_off | Autonomous work ended; unresolved objective, evidence, and pending work handed to an identified human/team |
| cancelled | New work stopped and in-flight disposition is known; previous changes remain recorded |
| failed / expired | Task could not finish, with a classified reason and any partial effects shown |

Terminal records do not restart in place. “Retry remaining work” creates a linked successor task using the remaining scope, current authorization, existing operation references, and fresh criteria. Automatic continuation while a task is live creates another run in the same task. These actions are different and must be labeled differently.

Successors retain the same accounting root and observe existing operations under their original identities. A new task or plan ID cannot mint a fresh key for an unresolved/confirmed previous effect. Cumulative consumption is never reset by retry. A successor may request an explicitly reviewed higher cumulative allowance within current policy; record the grant separately, keep prior consumption, and make the increment spendable only by successor work. The original task's authority stays immutable.

### 6.2 Scheduler and checkpoints

Postgres is the source of truth; BullMQ is delivery. A task coordinator advances deterministic steps or admits a new bounded reasoning run. It does not hold an SDK process, DB connection, or queue worker while waiting for a human/device/window.

Persist before yielding:

- Task/step identity, workflow version, target revision, and authority ceiling.
- Structured findings with provenance, uncertainty, source timestamps, and bounded text.
- Satisfied/unsatisfied criteria and exact operation/result dependencies.
- Budget/attempt consumption, deadline, next wake time, and the next permitted step.
- A monotonic transition sequence, scheduler lease_epoch, and separate reasoning attempt_ordinal.

Do not persist chain-of-thought or rehydrate raw tool output as instructions. A new run receives a bounded factual checkpoint and authoritative result references, not the SDK's old hidden state. The model proposes the next allowed step; server code validates it.

Initially use task-aware full-profile runs plus a registered submit_task_step outcome tool carrying a versioned, bounded finding/next-step proposal. It executes nothing. The recipe validates its permitted next-step keys, inputs, questions, and result references; output claiming success still requires the verification adapter. Existing specialized profiles feed task steps through typed finalizers without acquiring new tools. Every mutating tool call on a task-linked run must enter the operation reservation path, even if the model calls an existing tool directly.

Claim coordination through DB CAS and a short lease. Every checkpoint write and run/operation admission includes lease_epoch; stale coordinators cannot commit. Reclaiming a lease advances that fencing epoch but does not change attempt_ordinal or operation identity. Only admission of an explicit next reasoning attempt advances attempt_ordinal. One active reasoning run per task step. Fleet device execution can overlap only under the cohort rules in §9.

Keep existing run statuses and historical runs unchanged. Add nullable task_id, task_step_id, and task_attempt_ordinal to new linked runs. Unique admission identity is (org_id, task_id, task_step_id, task_attempt_ordinal); retries and lease recovery reuse it.

All continuation runs go through createAndEnqueueAgentRun. Extend its trusted internal input with task context rather than injecting it through arbitrary triggerRef JSON. The pinned agent ID must match the resolved effective agent; a replacement same-kind agent cannot inherit the task.

Record the prompt template version and the resolved model on every task-linked run (new nullable `prompt_version` and `resolved_model` columns on `ai_agent_runs`; the policy snapshot already carries the configured model, but runLoop.ts:1294 may fall back to the org's LLM default). No prompt registry exists today, so runs 1 and 4 of one task may use different released prompts. That drift is accepted, shown in task evidence, and written as a task event. Once T2 (§8.3) introduces versioned prompts, admission pins the version and a changed release requires an explicit successor, matching the workflow-version rule.

The existing enqueue_failed reclaim path can rewrite admission fields. For task-linked runs, reclaim is allowed only for a proven never-started admission with no effects, retaining the same task/attempt/agent/policy identity and charging reservations once. Otherwise reconcile or admit an explicit next attempt. Do not apply the legacy generic reset path to a task-linked row.

Continuation does not bypass org budgets, circuits, concurrency, hourly caps, or the task's lifetime caps. Existing incident cooldown still suppresses independent duplicate tasks. A same-task continuation with a satisfied dependency uses its dependency identity, not a new incident trigger; preserve a minimum wake interval and hourly limits so the incident cooldown cannot strand approved work or create a tight loop.

### 6.3 Durable wakeups and reconciliation

The core continuation path, for a supervised service-recovery task whose approval arrives after the technician's browser closed:

~~~mermaid
sequenceDiagram
  participant T as Technician
  participant I as Inbox / intentService
  participant R as intentReleaseWorker
  participant D as Domain executor (script)
  participant O as Task outbox
  participant C as Task coordinator
  participant V as Verification adapter
  participant S as Agent run (SDK)
  Note over C: task waiting(approval); no process, connection, or worker held
  T->>I: approve intent (MFA, four-eyes as configured)
  I->>O: intent_approved (same transaction as the decision)
  I->>R: release job (BullMQ)
  R->>C: dispatch claim CAS (task live? revision? deadline? authority?)
  C-->>R: claimed; operation in_flight
  R->>D: execute (idempotency key = operation identity)
  D-->>R: execution reference
  R->>O: intent terminal result (same transaction as terminalization)
  O->>C: wake (dedupe by org, task, source, transition)
  C->>V: verify criterion (fresh evidence, observation window)
  alt passed
    C->>C: completed + verified_resolved
  else failed or inconclusive
    C->>S: admit new run from checkpoint (attempt_ordinal + 1)
    S-->>C: submit_task_step (next allowed step, question, or handoff)
  end
  Note over O,C: lost Redis delivery: the reconciler re-derives the same wake from source rows
~~~

Add a task outbox record atomically with each task-affecting authoritative transition. Publish outside the DB transaction. Deduplicate by org, task, source kind, source ID, and transition identity.

Required sources: run terminalization, intent decisions and terminal results, domain execution result changes, verification results, user answers, target invalidation, and cancellation. Typed source IDs are references, not embedded raw payloads.

Intent approval makes an operation executable; it does not satisfy an execution dependency. Add completed/failed terminal publication to every intent writer, including the release worker, inline SDK path, and stale-execution/expiry paths. Two writers reachable by a task-linked intent publish nothing today (C18): the approvals rejection path (routes/approvals.ts:992-994) and `reapStaleExecutingIntents`' `failed:execution_lost`; a rejected or lost task operation would otherwise strand the task in `waiting` until its deadline, so both are in the thin slice's scope. Centralize the transaction helper where practical and pin writer coverage with a contract test. Existing audit “executed” labels are not completion events.

A reconciler queries live task dependencies and authoritative source rows after missed/duplicate/out-of-order delivery, recovering with the same stable wakeup identity. It also observes unresolved in-flight operations attached to terminal/handed-off tasks until a result or explicit unknown-effect disposition is recorded; task closure cannot hide a late result. Sources without a safe transactional outbox adapter initially use bounded polling from persisted next_wake_at; they must not pretend after-commit event publishing is durable.

Waits expire explicitly. A restart reclaims coordination and observes existing dependencies. It does not start the last mutation again.

Terminal publication alone cannot recover a late result, because the intent writers discard it today: the expiry reaper marks a slow `executing` intent `failed:execution_lost` (intentExpiryReaper.ts:275), and a release worker that loses the `executing → completed` CAS after the tool already ran logs and drops the returned result (intentReleaseWorker.ts:1054). The operation row therefore stores the execution reference the moment dispatch returns it and the result the moment it arrives, in their own writes that do not depend on winning the intent's status CAS. The reconciler reads the operation row and the domain source; it never infers "no effect" from an intent status alone.

Three more rules close the remaining holes. A wake is acknowledged only after the task transition it caused has committed; a consumer that fails leaves the outbox row unpublished and retriable. After a lease takeover, results produced by operations the superseded epoch dispatched are accepted under their original identity; only new admissions from the stale epoch are rejected. Recovery scans cover four sets: queued tasks past their admission wake, waiting tasks past `next_wake_at`, running tasks past lease expiry, and terminal tasks with an unsettled operation.

### 6.4 Automatic-trigger ownership

Each source occurrence and enabled workflow has one admission owner: legacy standalone admission or task admission, never both. Persist the selected path and org/source occurrence/recipe identity before either path can create work. During rollout, a per-workflow routing switch selects the path; duplicate/overlapping subscribers consult the same admission identity.

The routing switch is transitional, not a permanent mode. One release after a recipe passes its Phase 3 or Phase 4 gate, its legacy standalone trigger path is deleted and the switch removed. A contract test enumerates the trigger sources that still have a legacy owner so that list can only shrink. Two admission owners kept indefinitely is the hidden-second-route failure this repository has paid for before.

Repeated events for an active matching problem attach new evidence to its task. A genuinely new occurrence after closure creates a linked successor/new incident under explicit recipe matching rules. Independent tasks targeting an already-running conflicting effect attach to that result or wait/refuse; task-local idempotency alone does not prevent two different task owners from issuing the same work.

Today seven admission owners mint agent runs (alert, anomaly, schedule, sweep, ticket shadow, manual, chat handoff); the patch scheduler and fleet findings admit none (C1, C2), so what follows is Phase 4 work, not a second owner to reconcile now. Existing patch scheduler occurrences produce or adopt one task/job lineage when Operator management is enabled. Do not enqueue the ordinary patch job and an additional Operator-created job for the same occurrence. Enable/disable changes affect future occurrences; they never duplicate/replay an already-owned one.

### 6.5 Operation identity and asynchronous effects

An operation is reserved durably before either an act dispatch or an intent is created. Its identity includes task, step, target, workflow version, approved plan revision, and semantic operation ordinal; delivery retries do not change it. Store an argument digest and a stable idempotency key. The same key with different arguments is a conflict.

Use the existing act/intent authorization path, never a second execution bypass. Task-aware adapters register an operation before direct act execution and bind an intent atomically during intent creation. The two execution paths cannot both own one operation. Adapt createActionIntent's internal transaction contract where needed; attaching the task only after the intent commits is insufficient.

Concretely, the operation identity is reserved on the intent itself: nullable `task_id`, `task_step_key`, and `operation_key` columns on `action_intents` (all null or all set, by CHECK), and a permanent copy on the operation row. **One arbiter (C6).** Postgres `ON CONFLICT` suppresses conflicts on the named inference target only, and `createActionIntent` names `(org_id, idempotency_key)` (intentService.ts:1483-1486), so a second partial unique index on `(org_id, task_id, operation_key)` would raise a bare 23505 instead of an idempotent replay. Instead, a task-linked intent derives its `idempotency_key` from task identity (`task:<task_id>` + tool + argument digest + `operation_key`, through the existing `deriveIdempotencyKey` at :435-445) so the existing `action_intents_org_idem_uniq` index already enforces one live intent per operation and the existing `onConflictDoNothing` converges a continuation run onto it. The task-key index may exist as a redundant assertion, never as a second arbiter. **Two guards (C7).** That index covers live statuses only; `completed` and `failed` free the key while the effect may still be in flight, so it guards concurrent duplication. Sequential replay of a confirmed effect is guarded by the operation row's permanent uniqueness on `(org_id, task_id, operation_key)` with no status predicate. **Relaxation pairs with a recheck (C8).** The "explicit key reused by another run" rejection (intentService.ts:1517-1537) is relaxed only when task id and operation key both match and action, source, and argument digest still match; because release then evaluates the earlier run's snapshot, the relaxation ships only with the live-authority recheck at the dispatch claim (`revalidateApprovedIntentForRelease`, intentReleaseWorker.ts ~700), never alone. A contract test asserts a task-linked admission never yields a null `operation_key`, and the three new `action_intents` columns are classified `included` in `CORE_TENANT_EXPORT_POLICY` in the same PR (H5). P3-2 adopts these rows by reference when `ai_operator_operations` gains its full shape; it never recreates an intent or changes an execution key.

For the thin slice, the supported service restart is a device command (aiToolsScripts.ts:660-664), so the execution reference is the device command id, read back only through the authorized route path (`GET /devices/:id/commands/:commandId`, routes/devices/commands.ts:961-996; `device_commands` has no RLS, so never a direct select). Three clocks make "unknown effect" the slice's normal case, not an exception: the tool waits 30 s (aiToolsScripts.ts:662), the device command reaps at 5 min (commandTimeouts.ts:25-33, :145), and the stale-executing intent reaps at 20 min (intentExpiryReaper.ts:81). Between 30 s and 5 min the tool has returned `timeout` while the command may still succeed; `commandAcceptsAgentResultCondition` (commandResultAcceptance.ts:55-63) keeps that row open to a late result, and the operation row must observe it. Script executions, patch job targets, playbook executions, ticket comments, and report deliveries are the other reference kinds; each resolves through its adapter with an authorization check at read time (§11.3).

Supported task mutations that require review produce actionable intents, including approved Tier-2 shapes. Do not widen free-form legacy Tier-2 behavior or all registered tools. Each task operation needs a registered scope resolver, authority mapping, result adapter, and verification method before admission.

Persist typed references to domain executions: script execution, patch job/target result, remediation run/target, playbook execution, ticket comment/draft, or report delivery. A completed intent/tool dispatch may only advance the task to waiting/execution.

Distinguish:

1. Dispatch accepted.
2. Domain operation actually finished.
3. Task success criterion verified.
4. Optional recurrence observation completed.

Known non-execution may be retried under the recipe's bounded retry policy. Confirmed completed effects are never blindly replayed. An effect with lost acknowledgement, timeout, or unknown result requires authoritative reconciliation; if its absence cannot be proved and the provider lacks idempotency, hand off. Do not claim exactly-once external effects.

## 7. Authority, bounds, and cancellation

### 7.1 Authority across time

Admission pins agent identity, task origin, target scope, workflow version, and an effective authorization ceiling. Every later reasoning admission and effect rechecks:

- The task's accepted ceiling and targets.
- The originating run's immutable policy where an intent is being released.
- Current effective partner/org policy, current target ownership/site, and current applicable requester access.
- Workflow availability, operation reachability, asset/digest pins, kill switches, and circuit state.

Later policy expansion does not widen an existing task. Tightening takes effect immediately. Widening scope/authority requires a reviewed successor task; revising plan arguments creates a new operation and approval. Existing approvals only authorize their pinned arguments.

Reconstruct the original ai_agent principal with buildAgentAuthContext and assertRunOwnership. Database context has no synthetic human user ID. Service-layer coordination is not permission to call tools as system.

### 7.2 Task-wide budgets

Add task limits to the agent policy's `limits` object (packages/shared/src/validators/aiAgents.ts:33, `limitsFields`) and bump `AI_AGENT_POLICY_SNAPSHOT_VERSION` from 9 to 10 (packages/shared/src/types/aiAgents.ts:433) with readers that accept both. Partner/org limits merge to the narrower value; protected sets union. Missing values on v9 rows resolve to conservative task defaults only for explicitly enabled task workflows.

Proposed initial single-device defaults:

| Limit | Default |
|---|---|
| Reasoning runs per task | 4 |
| Mutation attempts per target across all runs | 3, counting nested playbook mutations |
| Aggregate model budget | 200 cents, also subject to existing org/day/run limits |
| Task deadline | 72 hours; recipes may be shorter |
| Automatic retry after confirmed non-execution | At most 1; ambiguous outcomes do not qualify |
| Active executable targets | 1 until fleet gates pass |

These are product defaults for validation, not measured performance claims. Reservations, usage settlement, and admissions serialize under the task budget. Count child runs and nested operations against both root-task and org limits; a new run cannot reset the budget. Actual provider cost may exceed a reservation by in-flight usage; report actual spend and block further admission.

A waiting task does not consume active-run concurrency. It still consumes a bounded pending-task quota and has a deadline. Proposed pending cap is 100 per org; admission returns a visible capacity result when full. Fixed evidence/result polling is bounded separately from model turns and never calls a model merely to check a timestamp.

### 7.3 Pause, cancel, expiry, and handoff

Pause prevents new reasoning/effect admission; read-only reconciliation continues. Cancellation first commits stopping, fences admissions, and cancels task-owned pending/approved intents using existing authorization semantics.

Define one durable dispatch claim, shared by direct act, intent release, and domain adapters, that checks task state/revision/deadline and serializes with pause/stopping/handoff under the same task lock/CAS boundary. For intents this claim **is** the existing `approved → executing` CAS (intentReleaseWorker.ts:676) with the task checks (state, revision, deadline, authority, `lease_epoch`) added to the same conditional UPDATE, not a second claim taken afterwards. The kill-switch reversal (`executing → approved`, :139) and cancellation (which today covers only `pending_approval` and `approved`, intentService.ts:2044) are extended in the same wave so a task-linked intent in `executing` always has exactly one owner and a cancel during execution records in-flight rather than silently no-op. A claim won before stop is recorded as in flight; one attempted after stop cannot dispatch. This is the linearization point, not a separate “check then send” read. No new effect may claim while paused, stopping, expired, handed_off, or otherwise terminal. Bound the claim-to-send interval; a lost/uncertain claim is reconciled, never blindly reissued.

An approval granted while paused remains an approved pending operation and cannot claim dispatch. Resume rechecks live authority and approval/release expiry; it never extends them. Handoff also fences new effects while preserving observation of preexisting claims.

Already executing commands may finish. Show them as in flight, collect late results, and transition to cancelled only after they are reconciled or explicitly recorded as unknown with a technician handoff. There is no run-level cancel today: `cancelled` and `expired` are valid `ai_agent_runs` statuses with zero production writers and no route (C17), so a cancelled task's in-flight reasoning run is fenced at its next tool call and left to finish; its outcome is recorded against the task but cannot admit new effects. Cancellation is not rollback. Compensation, when supported, is a distinct approved operation with its own result and verification.

Approvals keep their approval_expires_at and release_by semantics. Task deadlines cannot extend an approval. Rejected/expired proposals become an explicit blocked/handoff outcome; do not repeatedly request approval for the same rejected action.

Expiry stops new effects like cancellation and preserves observation of in-flight work. It must never display “nothing happened” if a change may still finish.

## 8. Verification, memory, and learning

### 8.1 Verification contract

Every criterion names an adapter/version, exact target, expected condition, pre-action baseline where needed, freshness requirement, bounded observation window, and acceptable outcome: passed, failed, inconclusive, or not_applicable. The model may explain the result but cannot award passed from prose.

- A successful script exit is execution evidence; it is insufficient for service/disk/application recovery without the recipe's endpoint criterion. The same holds for a device command: the agent's restart success is not proof the service runs (only Windows waits for `Running`, services_windows.go:132; macOS discards the stop error, services_darwin.go:128-130; C10), so service verification is always the independent `list_services` read (`verifyServiceRunning`, actVerify.ts:116-144), never the dispatch result.
- No freshness bound exists today (C9): `VERIFY_READ_TIMEOUT_MS` (8 s) is a read deadline and `FIX_HOLD_MINUTES` (60) is a recurrence hold. Each criterion carries an explicit `freshness_seconds`; the thin slice sets it per recipe rather than citing an existing constant.
- The existing watch gate does not fire for a supervised task run and can auto-credit (C11): `isFixWatchEligible` requires `modeAtStart === 'act'` (fixWatch.ts:133-139) and `watchReleasedIntent` marks an intent `verified` immediately when its run has no `alertId` (intentReleaseWorker.ts:436-441, 455). Task-linked runs use a task-specific eligibility keyed on the criterion, and nothing is credited `verified` without a passed criterion.
- Patch verification reads per-target/per-patch results and fresh inventory, observes required reboot/reconnect, and checks the configured health condition.
- Offline/stale telemetry is inconclusive, not healthy. Never widen a fleet cohort on inconclusive evidence.
- Alert dismissal/manual resolution alone is insufficient to prove the underlying problem recovered.
- A customer-reported problem without an objective check requires requester confirmation or an explicit technician resolution.
- Partial results preserve exact denominators: targeted, attempted, executed, verified, skipped, deferred, failed, and unknown.

Use current actVerify/fixWatch evidence where it meets the criterion. Immediate recovery and “no recurrence observed for N minutes” remain separate claims. Configurable hold windows (#4204) use stricter minimums/longer holds when merging policy, with an explicit maximum task deadline; impossible combinations fail validation.

A recurrence while a task is still watching invalidates its pending verification and causes bounded diagnosis or handoff. Recurrence after closure creates a linked new task and updates the historical observation, never silently reopens the completed task or erases its original evidence.

### 8.2 Memory (#4183)

Use recent, authorized task/run summaries keyed by org/device/problem and versioned partner/org runbook notes. Retrieve bounded relevant context with provenance, timestamp, expiry, and source accessibility. Exclude cancelled/failed trial proposals as facts about completed changes.

Suggested initial bounds: five prior task summaries, eight relevant notes, and a 12 KiB combined serialized payload. Overflows are explicit and deterministic. No cross-customer retrieval, unbounded transcript replay, secrets, or inferred authority from notes.

Runbook ownership follows the existing dual-owner shape. Org notes can add context and stricter constraints; they cannot negate partner constraints. Safety restrictions must be typed policy, not prose such as “never restart this server” alone. Show a configuration warning when a note expresses a protection that has not been encoded.

Human correction marks a fact superseded with attribution. Feedback may propose a corrected summary or a versioned prompt change; it does not silently rewrite historical evidence.

### 8.3 Evaluated improvement and graduation (#4180, #4175)

Start with offline evaluation of versioned prompt/examples on an org-authorized, redacted dataset. Hold out evaluation cases, compare against the released version, record costs and errors, and require an explicit version release. No online self-modifying prompts.

Existing recommend-only promotion and automatic demotion remain the default. Automatic promotion is a later opt-in capability, separately reviewed against real evidence. It requires a human-authorized partner ceiling, explicit per-org enrollment, a fixed eligible operation set, minimum verified samples/observation age, and zero unresolved failure/recurrence evidence. It cannot promote four-eyes, secret-bearing, unknown, or unsupported operations. Preserve immediate demotion and reversal history.

Automatic promotion is not a prerequisite for the “Operator built in” claim. The program can complete its core workflows with human-controlled graduation.

## 9. Fleet and patch execution

### 9.1 Bounded fleet rollout (#4173)

A fleet task contains frozen targets within one org. Keep individual device reasoning/act bindings single-device. The coordinator creates target steps/children and owns the cohort policy; no run receives unrestricted cross-device mutation authority.

Wave progression: canary → result verification → required observation hold → next cohort. Default canary is one eligible device; widening is opt-in and bounded by an approved configuration. A proposed rollout starts with a maximum of 10 targets and at most 2 concurrent device effects, both further narrowed by existing org exposure and policy limits. Larger configured limits require separate readiness evidence.

Exposure accounting reserves projected targets under the same org ledger/locking contract used for enforcement. It includes direct act, policy-decided, and workflow child effects without double-counting the same execution. Do not round a zero-device allowance up to one, exempt child runs, or let a batch approval exceed exposure policy.

The next cohort is admitted only if at least the configured minimum number of canary members actually executed and verified (minimum one, never zero), every attempted canary member meets verification/hold requirements, and no unresolved/in-flight operation remains. All-skipped/no-longer-applicable canaries do not pass. Replacement selection stays within the frozen target set and approved limits. A failed or unknown canary halts widening. Denominators use the actual cohort, not the entire planned fleet. Offline/deferred members do not count as successful canaries.

Freeze membership at admission; group/tag changes do not add targets mid-task. Removal, ownership change, or policy tightening blocks the affected target and reevaluates whether the remaining cohort still satisfies the plan. New devices require a new task.

### 9.2 Patch workflow (#4174)

Use existing patch policy/ring evaluation, patch snapshots, patchJobExecutor, patchSchedulerWorker, and patchRebootHandler. Extract the policy-driven route's complete job-creation logic into a shared service. Do not replace it with a helper that omits snapshot fields.

Current buildPatchesSnapshot pins policy filters, while patchJobExecutor resolves eligible patches at execution time. The task adapter must additionally freeze reviewed per-device update IDs/versions and intersect that immutable set with live eligibility at dispatch. Newly published/superseding updates require a new reviewed plan; a policy snapshot alone is insufficient. Apply the task dispatch claim/current-authority checks at per-device installation and again before post-install reboot scheduling, not only at job enqueue.

Workflow:

1. Resolve current assignment/ring, maintenance windows, allowed update set, platform support, and reboot/deferral policy.
2. Freeze the reviewed target/update scope and capture preflight health.
3. Submit a canary through the existing job executor under a task-aware authorized adapter.
4. Observe per-device/per-update results and required reboot recovery.
5. Verify update state and post-reboot health; apply the hold before widening.
6. Retry only proven retryable failed/unattempted work within policy; document skipped/deferred/failed devices.
7. Finish with verified scope and an exception ticket/report.

Existing patch jobs may be completed with skipped devices. Aggregate job completion cannot complete the Operator task. A patch change must obey existing update approval rules; approving the task is not blanket patch approval.

Do not assume generic deploymentEngine pause/resume/failure-threshold helpers are a complete fleet orchestrator. Current route/service states and helper call coverage require a readiness audit and integration tests before reuse. The existing patch and fleet-finding workers are the initial execution backends.

### 9.3 Scheduled findings (#4442)

Keep sweeps read-only. A finding carries a stable identity and typed evidence scope. A supported actionable finding can create a child task with a device-exact binding, freshly validated evidence, current policy, and shared parent/root budgets.

Phase 1 of this connection remains supervised. Unattended child execution is separately enabled only after fleet/exposure and graduation gates pass. Do not merely remove the existing hasScope → human_required rule for every scoped intent. Implement and test a narrowly typed workflow admission path that proves target, evidence, authority, and accounting.

Deduplicate by source sweep occurrence/finding/workflow/target. Repeat sweeps attach evidence to an active matching task rather than create competing work. The parent summary shows each finding's current task outcome and exceptions.

## 10. Helpdesk, communication, billing, and approval surfaces

### 10.1 Ticket completion (#4176)

Reuse applyAiFieldUpdates, addAiTriageNote, ticket drafts, ticket transitions, and existing outbox delivery. Preserve human field provenance and do not overwrite technician work.

Initial delivery: metadata/private notes under existing explicit autonomy; customer responses remain reviewed drafts. A technician can authorize a specific reply and then the task waits for its delivery and the customer's answer. A linked endpoint subtask requires validated device ownership and its own permitted recipe; ticket text never establishes device authority.

Later category-bound autonomous replies/closure require a separate capability, per-org opt-in, verified recipient/thread binding, a reliable AI attribution path, duplicate-send protection, and acceptance data. Existing sendTicketDraft attributes the message to the human technician; it must not be reused to impersonate a technician during autonomous sending.

Auto-close requires recipe-specific verification and the configured confirmation rule. Sensitive/access/billing requests, conflicting identity, ambiguous targets, failed delivery, or uncertain resolution hand off. A reopened ticket starts a linked new task. Do not turn lack of reply into “verified fixed.”

### 10.2 Time and business follow-through (#4177, #4182)

Create evidence-backed time/service suggestions using existing timeSuggestionService and timeEntryService semantics. Default to technician review before posting labor or billable records.

Keep four quantities distinct: AI elapsed time, actual model cost, measured human labor, and estimated avoided effort. Neither AI run duration nor estimated savings becomes fabricated technician time. If a partner sells an AI service unit, use an explicitly configured catalog item/contract rule with correct attribution.

Quote/invoice follow-through uses existing commercial services and separate approvals for concrete documents/recipients/amounts. This program supplies typed task references and suggestions; it does not enable autonomous financial posting or sending by virtue of technical task approval.

Measure resolution duration from accepted intake to verified outcome, approval/device wait separately, human intervention count, recurrence, and cost per verified task. Cohort/MTTR comparisons show the population, exclusions, and observation period; they do not imply causal time savings without a defensible comparison.

### 10.3 Approval channel parity (#4179)

Web task detail and the existing inbox are the first complete surfaces. Mobile then receives task provenance, batch parity, and exact return links. Slack/Teams notifications link to the same authenticated decision ceremony initially.

Any later native channel action must preserve identity, tenant/scope, MFA/step-up, four-eyes rules, expiry, argument binding, replay protection, and decision races. Channel messages must not leak raw tool inputs or cross-customer data. A chat reaction is not an approval credential.

## 11. Data model and tenancy contract

This is the minimum logical model; each implementation wave supplies exact Drizzle/SQL migrations and typed validators before coding dependent services. No generic graph or arbitrary instruction executor is introduced.

| Table/change | Essential fields and invariants | Tenancy |
|---|---|---|
| ai_operator_tasks | id, org_id, agent_id, workflow_key/version, optional workflow_config_id/parent_task_id/successor_of_task_id/accounting_root_task_id, source kind + typed source links, origin/requester/human owner, objective, frozen scope/criteria/authority, mode, state/phase/wait reason, revision/lease_epoch, budget, deadline, next_wake_at, outcome, timestamps | Shape 1; immutable org, agent identity, admitted scope/authority; parent/successor/root composite same-org FK; root has no root pointer |
| ai_operator_task_targets | id, org_id, task_id, nullable device/ticket links as applicable, frozen display label, target ordinal, state, detached_at/reason | Shape 1; same-org parent and target FKs; null means detached, never unrestricted |
| ai_operator_task_steps | id, org_id, task_id, recipe step key, target_id if applicable, attempt_ordinal, state, typed checkpoint/dependencies, expected criterion, revision | Shape 1; unique task/step/target identity; same-task and same-org target FK |
| ai_operator_operations | id, org_id, task_id/step_id, stable op key, plan revision, argument digest, originating run, nullable intent link, typed execution references, dispatch/result/verification states | Shape 1; unique org/op key; same-org links; one execution owner; immutable approved identity |
| ai_operator_task_events | id, org_id, task_id, transition sequence, event type, actor attribution, safe bounded detail, created_at | Shape 1; append-only; unique task/sequence; no raw transcript |
| ai_operator_task_outbox | id, org_id, task_id, source identity/transition, due_at, published_at, attempts | Shape 1; unique org/task/source/transition; replay-safe scheduler delivery. Deliberately RLS-scoped: `intent_outbox` is `INTENTIONAL_UNSCOPED` (rls-coverage.integration.test.ts:89) because the agent WS path reads it, but the task coordinator must respect tenancy, so this is the repository's first RLS-scoped outbox and must never be added to that allowlist (C20) |
| ai_operator_workflows | id, partner_id XOR org_id, baseline_workflow_id for org override, recipe_key/version, name, enabled, typed settings/trigger/scope restrictions, created/updated attribution | Existing dual-owner shape; org is a tightening override; named configurations permit many per agent kind |
| ai_operator_runbook_notes | id, partner_id XOR org_id, optional baseline note link, scope selectors, typed note kind, bounded content, version, expiry, superseded reference, attribution | Dual-owner config shape; no customer facts on partner-wide notes |
| ai_agent_runs additive columns | nullable task_id, task_step_id, task_attempt_ordinal | Composite same-task/same-org references; old rows unchanged; one admission per step/attempt |
| Intent/task association | operation row binds intent and original run; task/operation binding participates in creation and release checks | Existing intent tenancy; no client-controlled task authority blob |

Task checkpoint/criteria/dependency JSON uses closed, versioned Zod discriminated unions with limits, not arbitrary provider payloads. The run's three task-linkage columns must be all null for legacy runs or all present for task runs, enforced by a CHECK. Execution references resolve through explicit adapters; use typed FK columns for supported local tables and verify same-org ownership where an existing table lacks a suitable composite key. A string “resource ID” is never sufficient authorization.

Every new tenant table gets ENABLE and FORCE RLS plus policies in the creating migration. Direct org tables use breeze_has_org_access(org_id); dual-owner tables follow the existing partner/org policy shape and required allowlist registration. Define relevant partner visibility explicitly. There is no app-only tenancy fallback.

Add composite (id, org_id) parent keys and matching child FKs; ensure nullable detach semantics do not clear org_id. Same-org alone is insufficient for task lineage: targets/steps expose (id, task_id, org_id), and run/step/target/operation links use task-qualified composite FKs. An operation's run must belong to its task and step; an attached intent must name that same originating run, enforced by a suitable composite key/FK or a deferred constraint trigger. Reject task-A/step-B and operation-A/intent-B links even within one org. Validate parent/root chains as acyclic and belonging to one accounting root.

Register RLS coverage, tenant export/erasure, org merge, and device/ticket move behavior in the same wave. Site restriction is new work, not an extension: AI agent runs are not site-filtered today (`routes/aiAgents.ts` has no `allowedSiteIds`/`canAccessSite` reference, while `routes/devices/core.ts` does; C15). User-facing site restrictions are enforced on task list/detail/events, target aggregates, and referenced evidence; an inaccessible target cannot leak through a summary/count. Initial site-restricted views only expose tasks whose entire accepted scope is accessible; partial fleet projections require their own design.

Task, operation, event, and run history stays in the source org. Device/ticket moves first detach affected live lineage and mark unfinished targets unavailable. Pending execution is fenced; null targets cannot be reconstructed from frozen labels. Saved historical display text remains source-org history. Do not re-stamp task/run org_id. Use leave-for-erasure for immutable history in org merges; define workflow/note override handling explicitly rather than repointing immutable execution records.

FK direction must remain acyclic for erasure: task → agent/config; target/step → task; run → task/step; intent → run; operation → step/run/intent; event/outbox → task. Steps carry dependency references without reverse FKs to operations/runs. Never add a task.current_run_id FK back to runs. Validate deletion order against actual registries.

Retention: use the approved AI/audit retention policy, with separately bounded checkpoint text and longer permitted outcome metadata. Export classification follows the repository rule without exception: every `json`/`jsonb` column is `excludedOpen`, so anything a customer must be able to export (objectives, questions, answers, handoff summaries, runbook text) lives in bounded `text` columns classified `included`, never only inside a checkpoint or criteria container. Every composite FK that references an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE` (org merge runs `SET CONSTRAINTS ALL DEFERRED`). `ai_operator_task_events` is append-only (REVOKE DELETE plus immutability trigger) and is therefore also registered in `AUDIT_ADMIN_REQUIRED_TABLES`. `ai_operator_workflows` and `ai_operator_runbook_notes` get the separate SELECT-only partner-wide policy (`org_id IS NULL AND partner_id = breeze_current_partner_id()`), registered in `DUAL_AXIS_TENANT_TABLES`, never appended to the `FOR ALL` policy. Erasure also removes queued wakeups and prevents re-creation. Raw input redaction work (#4181) is a prerequisite to exposing additional trace content, not permission to copy raw outputs into task events; note that `/admin/tool-executions` is gated by `ORGS_READ`, not platform admin (routes/ai.ts:129, 1238-1239; C14), so the exposure is wider than the issue records.

Migrations must be new, idempotent, date-prefixed, correctly ordered, and contain no inner transaction blocks. Do not edit shipped migrations. Inspect existing filenames before choosing the prefix: the newest shipped migration is `2026-10-13-110000-scripts-security-acknowledgement.sql` (C16), more than five weeks ahead of the authoring date, so a file named for today would replay before it; re-verify against `origin/main` at push time.

### 11.1 Indexes and read paths

Every new table is read under forced RLS as `breeze_app`, where only leakproof operators (`uuid_eq`, `texteq`, timestamp comparisons, `IS NULL`) can become index conditions. jsonb `->>`, `LIKE`, and enum equality cannot, and one leaky arm turns an entire `OR` into a post-policy filter. State and phase columns are therefore `text` with CHECK constraints, never `pgEnum`, and partial-index predicates are stated verbatim as constants in the query (a literal written into a Drizzle `sql` template is inlined; an interpolated `${value}` or `eq()` binds a parameter the predicate proof cannot see). Required in the creating migration:

| Table | Index | Serves |
|---|---|---|
| ai_operator_tasks | `(next_wake_at) WHERE state = 'waiting'` | coordinator poll |
| ai_operator_tasks | `(org_id, state, updated_at DESC)` | workspace lists, attention counts |
| ai_operator_tasks | `(org_id, accounting_root_task_id)` | budget rollups |
| ai_operator_tasks | `(lease_expires_at) WHERE state IN ('running','stopping')` | lease reclaim |
| ai_operator_task_outbox | `(due_at, id) WHERE published_at IS NULL` | publisher poll (precedent: `intent_outbox_unpublished_idx`; `ticket_outbox` in 2026-09-19-ai-agents-ticket-shadow.sql:96) |
| ai_operator_operations | `(org_id, task_id, result_state)`; `(intent_id) WHERE intent_id IS NOT NULL` | reconciler; intent to operation lookup |
| ai_operator_task_events | `(task_id, sequence)` unique | detail page, event polling |
| ai_operator_task_targets | `(device_id) WHERE device_id IS NOT NULL`; same for ticket | #5022 device-page feed; move/detach |
| ai_agent_runs | `(task_id, task_step_id, task_attempt_ordinal) WHERE task_id IS NOT NULL` unique | admission identity |

Each polled or list query ships with an EXPLAIN contract test that runs as `breeze_app` with the `breeze.*` GUCs set and `enable_seqscan = off` against skewed data (precedent: `deviceEventsFeedIndexes.integration.test.ts`). A plan captured as `doadmin` proves nothing.

### 11.2 Operational contract

The coordinator and outbox publisher are two new Postgres pollers on the shared connection pool that also serves agent traffic. They are bounded before any recipe is enabled:

- **Scheduling:** the coordinator and publisher tick sub-hourly (proposed `every:` 15 s and 5 s), which is below `COARSE_REPEAT_INTERVAL_MS` and deliberately outside `apps/api/src/jobs/scheduleRegistry.ts` (:29, :68). The hourly reconciler pass and the daily retention job register on a free lane. No bare `every: 24h`; BullMQ aligns those to the Unix epoch, so every such job fires together at 00:00 UTC. Task deadlines add ±10 % jitter so the 72-hour default does not create an expiry wave.
- **Batching:** each tick claims at most N tasks (proposed 50) with `FOR UPDATE SKIP LOCKED`, processes them under one short lease, and releases the connection before any wait. The reconciler scans only tasks whose `next_wake_at` or `lease_expires_at` has passed, never the whole live set.
- **Metrics** (`services/metricsRegistry.ts`, prom-client): `ai_operator_tasks_by_state`, `ai_operator_waiting_age_seconds_max`, `ai_operator_outbox_unpublished`, `ai_operator_outbox_oldest_age_seconds`, `ai_operator_lease_reclaims_total`, `ai_operator_unknown_effect_handoffs_total`, `ai_operator_dispatch_claim_conflicts_total`, `ai_operator_reconciler_scan_rows`. Alert thresholds are set during the P3 pilot and recorded in the runbook before the P3 release gate.
- **Kill switch:** the existing AI kill switches fence new admissions and dispatch claims; the publisher and reconciler keep running so late results still land. Turning the coordinator off entirely is a separate operational flag and leaves tasks visibly `waiting` with a stale `next_wake_at`, which the waiting-age metric exposes.

### 11.3 Reference lifecycle matrix

Two existing behaviours rule out naive same-org composite FKs for some links: `script_executions` is device-denormalized and restamped to the new org on device move (routes/devices/core.ts:265, moveOrg.ts:584), and `ai_agents` rows are repointed to the survivor on org merge (orgMergeCustomExecutors.ts:764), while task `org_id` is immutable. Each reference therefore has an explicit shape:

| Reference | FK shape | Device move | Org merge (loser) | Erasure | Export |
|---|---|---|---|---|---|
| task → org | `org_id` NOT NULL, immutable | unchanged | leave-for-erasure (history) | cascade list, children first | `included` |
| task → agent | plain FK `agent_id → ai_agents(id)` ON DELETE RESTRICT; same-org checked at admission, not by composite FK; frozen agent kind/name/snapshot on the task | unchanged | agent row repoints, task keeps its immutable org; live tasks fenced by the merge executor | task before agent | `included` |
| task → workflow config | plain FK ON DELETE SET NULL; frozen recipe key/version on the task | unchanged | config follows the dual-owner merge rule; task keeps frozen values | independent | `included` |
| target → device | `device_id → devices(id)` ON DELETE SET NULL, no composite; `detached_at`/`reason`; frozen label | move hook sets `detached_at`, fences pending execution; label retained | leave-for-erasure | with task | `included` |
| target → ticket | same shape as device | ticket move hook detaches | leave-for-erasure | with task | `included` |
| step/event/outbox → task | composite `(task_id, org_id)` DEFERRABLE INITIALLY IMMEDIATE | unchanged | leave-for-erasure | before task | `included` (text), `excludedOpen` (json) |
| run → task/step | composite `(task_id, org_id)` DEFERRABLE, nullable, all-or-none CHECK | unchanged (runs stay in source org today) | leave-for-erasure | run before task | existing run policy |
| intent → task/operation | nullable `task_id`, `task_step_key`, `operation_key` on `action_intents`, composite `(task_id, org_id)` DEFERRABLE | unchanged | existing intent merge rule | existing intent order | existing intent policy |
| operation → intent | composite `(intent_id, org_id)` DEFERRABLE, ON DELETE SET NULL | unchanged | leave-for-erasure | operation before intent | `included` |
| operation → execution reference (device command, script execution, patch job target, playbook execution, ticket comment, report delivery) | typed `(execution_ref_kind, execution_ref_id)`, **no hard FK**; same-org verified at write; authorized adapter read on every access | reference kept as history; live operations fenced by the target detach | leave-for-erasure | reference row may be erased first; adapter returns "evidence erased" | `included` (ids only) |
| successor/parent/root → task | composite `(task_id, org_id)` DEFERRABLE, acyclic, one accounting root | unchanged | leave-for-erasure | children before parents | `included` |
| runbook note → baseline note | same dual-owner shape as config policies | n/a | dual-owner merge rule | independent | `included` (text) |

"Leave-for-erasure" means the loser org's Operator history is neither repointed nor deleted by the merge; it is erased with the loser org through the ordinary cascade. The merge executor fences any live loser-org task first (stop new admissions, record in-flight) so nothing executes under a dead tenant.

## 12. API and implementation boundaries

Add routes under /api/v1/ai/operator, separate from the already large aiAgents route module.

| Endpoint | Contract |
|---|---|
| GET /workflows | Server-computed readiness: recipe/version, supported triggers/platforms, availability/setup reasons, permitted scope and criteria |
| POST /task-drafts | Interpret/validate objective and scope; returns typed reviewed proposal, no operational execution |
| POST /tasks | Explicit mode trial/live, org, recipe/version, validated inputs, targets, criteria, requested bounds, optional source record, client idempotency key; returns accepted task ID or actionable refusal |
| GET /tasks and /tasks/:id | Scoped keyset list/detail with next action, outcomes, typed dependencies, safe evidence, and existing run/intent links |
| POST /tasks/:id/answers | Answer a specific pending question with expected revision; scope/authority changes cannot be hidden in an answer |
| POST /tasks/:id/pause, /resume, /cancel, /handoff | Expected revision, validated reason/owner, current authorization; idempotent state transitions |
| POST /tasks/:id/retry | Creates reviewed successor for remaining work, never resets old task/effect history |
| GET /tasks/:id/events | Bounded authorized event history; polling first, streaming can be additive |
| Workflow config/note CRUD | Existing policy-management authority, dual-owner rules, typed config; separate resources/files |

Use 409 for stale revision/idempotency conflict, 422 for unsupported workflow/criteria/setup, 403 or non-enumerating 404 for unauthorized targets, 429 for admission capacity, and 503 when acceptance cannot be persisted. Once task + outbox commit, 202 is truthful even if Redis is temporarily unavailable: the task shows queued with recoverable delivery state.

Recompute readiness on launch and before dispatch. A cached catalog or draft is never authority. Requests cannot supply a principal, effective policy, approval result, or trusted continuation token.

Suggested module boundaries:

- services/aiOperator: taskService, taskCoordinator, taskTransitions, operationService, taskReconciler, taskContext, workflowCatalog, verification, per-domain adapters.
- jobs: operatorTaskWorker and operatorTaskOutboxPublisher; register in existing worker role/registry/queue lifecycle.
- Existing aiAgents: trusted task admission and checkpoint prompt support, without a second SDK runtime.
- Existing actionIntents: task binding, terminal publication, cancellation/expiry dispatch fence.
- Existing domain services: authoritative execution, reconciliation, and result projection.
- Web: OperatorPage, OperatorTaskDetail, TaskCreateFlow, and reusable evidence/approval components.

Do not split unrelated working modules merely to meet a line count. New orchestration logic gets cohesive files and colocated tests.

## 13. Delivery, evaluation, and definition of done

Deliver in the order described in the [delivery plan](../../plans/ai-mcp/2026-09-07-ai-operator-completion.md):

- **Phase 3 — task completion:** a thin vertical slice first (one recipe, one target, supervised intent path, acceptance scenario 3 end to end), then the full task model, continuation, verification, trials, and the Operator workspace.
- **Phase 4 — fleet operations:** executor readiness, canary rollout, scheduled child tasks. Patch maintenance is sequenced last among execution-expanding waves as a recommended order, not a technical dependency (plan §9, decision D1); its hard prerequisites are executor readiness, verified canaries, reboot fencing, and its own pilot evidence.
- **Tracks T1–T5 (parallel, individually gated):** ticket follow-through, memory and evaluated feedback, measurement and time suggestions, approval access, optional automatic promotion. These are not a phase: none shares a release boundary, and none expands execution scope without its own gate.

Waves are 2 to 5 pull requests each. The plan registers one sub-issue per PR-sized unit, not per wave heading.

Read-only intelligence and historical run pages continue working throughout. Do not convert old completed/awaiting-approval runs into active tasks or replay existing intents. Historical records may gain read-only links only where provenance is unambiguous.

Feature controls separate task infrastructure, each executable recipe, fleet widening, customer sending/closure, and auto-promotion. New autonomy is off by default. Use the existing kill switches as overriding gates; turning a new switch off fences new effects but keeps result reconciliation and audit available. Old workers must not consume new task jobs before they support the contract.

Required acceptance scenarios:

1. Launch a supported investigation without knowing a tool name; unsupported requests fail before execution.
2. Trial produces useful evidence and cost, with zero operational effects, actionable approvals, child execution, or graduation credit.
3. Approve after browser close/worker restart; the operation executes once under its identity, results arrive, and a new run continues only when needed.
4. Duplicate/out-of-order events, lost Redis delivery, and source-event failure converge through reconciliation without duplicate effects.
5. Crash before dispatch, after dispatch, after domain result, and before checkpoint commit; each boundary either recovers evidence or hands off an unknown effect.
6. Approval is granted but job is pending; task stays waiting. A completed patch job with skipped targets stays partial/deferred.
7. Failed/inconclusive verification cannot produce “Resolved,” graduation success, or cohort widening.
8. Policy is tightened, requester access revoked, task expired, or target moved between approval and execution; new effects stop.
9. Cancellation races approval/dispatch; accepted in-flight work is visible, no new target starts, and no rollback is claimed.
10. A failed first canary halts all widening; an offline canary does not dilute failure statistics.
11. Ticket answers, closure, and retries preserve identity and human changes; duplicate delivery creates no duplicate message, note, time entry, or task.
12. Cross-org and cross-site reads/writes, aggregate counts, exports, move/merge, and erasure obey the contracts under the actual breeze_app DB role.
13. Existing standalone runs, approvals, agent settings, schedules, and bookmarks retain their behavior.
14. Actual external/task side effects have durable identity and result evidence even when telemetry, notification, or learning writes fail.
15. Legacy and task subscribers race for the same source/patch occurrence; one work lineage wins, including during enable/disable changes.
16. Pause → approve → no dispatch → authorized resume; expired approval remains expired, and a revoked requester requires a reviewed successor under the new owner.
17. A technician closes the app before a question/handoff; authorized recipients receive a durable actionable notification or delivery failure is visible.
18. A patch published after review is not added to the job; cancellation between install and reboot fences the reboot. An all-skipped canary never permits widening.

Use deterministic adapter tests, live-DB contracts, and Playwright data-testid flows for these cases. Model evaluation uses representative supported incidents with known outcomes, unsuccessful cases, ambiguous requests, stale/offline targets, and missing permissions. Development tests use mocked endpoints; controlled pilot tasks run only on explicitly enrolled test/customer scope.

Each workflow release needs at least 50 representative evaluated cases, including at least 10 failure/unknown/wait cases, zero observed unauthorized/out-of-scope or duplicate effects, zero false verified-success labels, and explicit accounting of unresolved cases. These are minimum release samples, not statistical proof of universal reliability. Product review sets a workflow-specific verified-completion target before the pilot; publish sample size, target, achieved rate, cost, and intervention rate together.

Fleet widening and customer-autonomous sending additionally require evidence from at least one explicitly enrolled real partner, two weeks of observed use, and documented acceptance of the remaining failure cases. Pause rollout on a false-success, duplicate-effect, scope, or uncontrolled widening incident; repair and rerun the affected gate.

Marketing may describe only enabled, verified workflows:

- After Phase 3: “Investigates supported incidents, carries out permitted fixes, resumes after approvals, and verifies the outcome.”
- After Phase 4: add bounded fleet remediation and patch maintenance for the released platforms/rings.
- After the applicable track gates: add supported ticket completion and measured operational reporting.

Automatic financial sending, arbitrary cloud-account administration, arbitrary custom playbooks, and unrestricted agent collaboration remain outside this program's claims.

## 14. Review record

- 2026-09-07: three independent document reviews folded into the first draft.
- 2026-09-07: Fable review against origin/main b3d528d869. Added the summary, the §3 precedence rule, the §6.1 and §6.3 diagrams, the §6.2 prompt-version rule, the §6.4 legacy sunset, §11.1 indexes, §11.2 operational contract, verified citations in §2, and the thin-slice and track restructure in §13 and the plan.
- 2026-09-07: W01 (#5214) P3-0a baseline re-verified every §2 citation at `89b059f12f` and recorded 20 contradictions. Folded in: C1/C2 (§6.4), C4/C5 (§2), C6/C7/C8 (§6.5 single-arbiter key derivation, two guards, recheck pairing), C9/C10/C11 (§8.1), C14/C15/C16/C20 (§11), C17 (§7.3), C18 (§6.3). C3, C12, C13, C19 are plan and issue corrections. Pre-existing hole outside scope filed as #5232.
- 2026-09-07: Codex `xhigh` (gpt-6-astra, read-only) quorum on the revised draft: **PROCEED WITH CHANGES**. Two critical findings (task-scoped operation identity must be reserved on the intent in P3-1, because intent keys are run-scoped and live-only; late results are discarded by the reaper and the losing-CAS path, so operation rows must persist references and results independently). Five high findings (the dispatch claim must be the existing `approved → executing` CAS, not a second claim; P3-1 needs an explicit step representation; `script_executions` and `ai_agents` change org, so those links cannot be same-org composite FKs; deferrable FKs, append-only registration, partner-wide SELECT policies, and export wording had to be made explicit; recovery scans must cover queued and terminal-unsettled tasks). One disagreement on D1 (accepted: recommended order, not dependency). Four citation corrections (`event_type`, `scheduleRegistry` threshold, resolved model, device-command executor). Every claim was verified against the code before being folded in; §2, §6.2, §6.3, §6.5, §7.3, §11, §11.2, §11.3, and plan P3-0/P3-1/P3-2/P3-3/§9 changed as a result.
