---
title: AI Operator completion — delivery plan
date: 2026-09-07
status: draft; implementation not started
spec: ../../specs/ai-mcp/2026-09-07-ai-operator-completion-design.md
tracking_issue: LanternOps/breeze#5205
---

# AI Operator completion: delivery plan

## 1. Deliverable and authority

Implement the [continuation spec](../../specs/ai-mcp/2026-09-07-ai-operator-completion-design.md) as two phased releases plus five parallel tracks. Phase 3 completes supported single-device tasks, proving one recipe end to end with a thin vertical slice before the full task model is built. Phase 4 extends tasks to bounded fleets and patch maintenance. Tracks T1–T5 (tickets, memory, measurement, approval access, automatic promotion) each carry their own gate and run alongside Phase 4; they are not a phase and have no shared release boundary.

This plan is a reviewable implementation breakdown, not a record of approved product decisions or completed work. No new GitHub issues, external messages, deployments, production flags, or migrations were created when writing it. Existing issue references below were read on 2026-09-07.

**Wave size and registration.** Every wave below is 2 to 5 pull requests. Each wave lists its PR split, and each PR-sized unit is one `wave` sub-issue (not one per wave heading), because a `Closes #` line closes its sub-issue on the first merge. Registration is staged: the parent (LanternOps/breeze#5205) and the P3-0/P3-1 units (#5206–#5212, keys W01–W07) were registered on 2026-09-07; each later wave's units are added with `add_wave` once its predecessor's exit is recorded, so the slice's lessons shape P3-2 before it is committed to issues. Branch names follow `feature/5205-ai-operator/wave-<subissue#>`. Wave state lives on GitHub (`get_feature_status`), never in this document.

The spec's authority, idempotency, result-verification, tenancy, and cancellation contracts apply to every wave. A later wave cannot weaken them to make an existing executor easier to call.

## 2. Existing work and issue disposition

Phase 1 (#3821), Phase 2 (#4187, all six waves), and builder (#5048) are already closed. Preserve their implementation; do not recreate those features from old unchecked plan boxes.

| Existing issue | Continuation delivery | Completion evidence required |
|---|---|---|
| [#4173 Fleet fan-out](https://github.com/LanternOps/breeze/issues/4173) | P4-1 | Verified canary/hold/widen with exposure enforcement and halt behavior |
| [#4174 Patch runner](https://github.com/LanternOps/breeze/issues/4174) | P4-3 | Real policy-driven patch/reboot/verification workflow and exceptions |
| [#4442 Sweep child runs](https://github.com/LanternOps/breeze/issues/4442) | P4-2 | Read-only finding → device task, shared budgets, supervised then gated unattended mode |
| [#4176 Customer replies/auto-close](https://github.com/LanternOps/breeze/issues/4176) | T1 | Human-reviewed path first; bounded autonomous send/close only after its pilot gate |
| [#4177 Time entries](https://github.com/LanternOps/breeze/issues/4177) | T3 | Correctly attributed, replay-safe time/service suggestions and reviewed posting |
| [#4178 Anomaly trigger](https://github.com/LanternOps/breeze/issues/4178) | Shipped in code (baseline C12: `triggerKind: 'anomaly'` subscriber, CHECK, `anomaly_incident_id`); W02 confirms end-to-end coverage, then close | The Phase 2 spec §11 "deferred" entry and the `status:idea` label are stale; comment posted 2026-09-07 |
| [#4179 Slack/Teams/mobile approvals](https://github.com/LanternOps/breeze/issues/4179) | T4 | Authenticated task links and mobile parity; native decisions need equivalent ceremony |
| [#4180 Feedback adaptation](https://github.com/LanternOps/breeze/issues/4180) | T2 | Versioned examples/prompts, holdout evaluation, explicit release and reversal |
| [#4181 Raw input redaction](https://github.com/LanternOps/breeze/issues/4181) | P3-0/P3-5 prerequisite for richer trace | Safe DTO/export contract; no raw input copied into task history. Gate is `ORGS_READ`, not platform admin (C14); comment posted 2026-09-07 |
| [#4182 Measured impact](https://github.com/LanternOps/breeze/issues/4182) | T3 | Defined denominators, actual task timings/interventions/cost and honest comparison |
| [#4183 Prior-run/runbook memory](https://github.com/LanternOps/breeze/issues/4183) | T2 | Scoped retrieval, freshness, corrections, RLS and no authority from prose |
| [#4175 Automatic promotion](https://github.com/LanternOps/breeze/issues/4175) | T5, optional after core completion | Explicit enrollment, verified evidence, fixed bounds and immediate demotion |
| [#4204 Fix-watch windows](https://github.com/LanternOps/breeze/issues/4204) | P3-4 | Typed hold/freshness requirements and correct stricter merge semantics |
| [#4206 Policy-action watches](https://github.com/LanternOps/breeze/issues/4206) | Re-scoped to P3-4 | Intent-anchored watches are implemented; the residual gap is the non-alert-anchored intent credited `verified` on release with no watch (C13, intentReleaseWorker.ts:436-441). P3-4's task-specific verification gate closes it; comment posted 2026-09-07 |
| [#4461 Approval deep links](https://github.com/LanternOps/breeze/issues/4461) | P3-5 | Exact task/intent navigation from detail and inbox |
| [#5022 Device work visibility](https://github.com/LanternOps/breeze/issues/5022) | P3-1 (read-only feed), P3-5 (full) | Task/run activity visible from its authorized device record |

The original Phase 2 deferral to “P2-5” for sweep auto-execution was superseded by #4442. Its implementation is not part of the already-closed graduation wave.

New scope from the assessment: durable task ownership, continuation after domain results, task-wide budgets, operation identity across runs, uniform supported task proposals, task-specific criteria, trial mode, task intake, and the Operator workspace. These need new tracking items when implementation is authorized.

## 3. Dependency and release order

~~~mermaid
flowchart TD
  A[P3-0 Baseline and adapter contracts] --> B[P3-1 Thin slice: one task, one recipe, approval continuation]
  B --> C[P3-2 Task model, admission, budgets, API]
  C --> D[P3-3 Operations, wakeups, continuation, stop]
  D --> E[P3-4 Verification, recipes, trials]
  E --> F[P3-5 Operator workspace and pilot]
  F --> G[P4-0 Domain executor readiness]
  G --> H[P4-1 Bounded fleet coordination]
  H --> I[P4-2 Scheduled finding tasks]
  H --> J[P4-3 Patch maintenance]
  F --> T1[T1 Ticket completion]
  F --> T2[T2 Memory and evaluated feedback]
  F --> T3[T3 Measurement and time suggestions]
  F --> T4[T4 Approval channel parity]
  T1 -. D1: recommended before .-> J
  T3 -. D1: recommended before .-> J
  T2 --> T5[T5 Optional automatic promotion]
  T3 --> T5
~~~

P3-1 proves the continuation contract on real code before P3-2 designs the full task model around it. P3-5 proves one complete single-device workflow before fleet work begins. Tracks that do not expand execution scope proceed alongside Phase 4. Automatic replies, fleet widening, patch maintenance, and automatic promotion remain individually gated.

## 4. Phase 3: tasks that finish

### P3-0 — Baseline and contracts

Goal: remove ambiguity about which existing services can truthfully supply execution, completion, and verification.

**W01 delivered (#5214):** `docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-p3-0-baseline-contracts.md`, baseline `89b059f12f`: adapter interface, the service-recovery recipe card with its three clocks (30 s tool wait, 5 min command reap, 20 min stale-executing reap), a 19-writer terminal inventory, the operation identity predicate and its five hazards, a 7-entry legacy owner list, export classification for the P3-1 columns, move/merge hooks, the scheduler lane (`:02`), and 20 contradictions now folded into the spec. W02 (#5207) remains.

- [ ] Reconcile issue status against code/tests for already implemented anomaly triggers and intent fix watches (#4178, #4206). Record scope differences; do not close issues solely because similarly named code exists.
- [ ] Inventory all run and intent terminal writers, including inline execution and stale-result reapers.
- [ ] Define typed execution adapters: admit, dispatch/reference, observe, verify, cancel-if-supported, reconcile-unknown.
- [ ] Confirm the quorum-settled operation identity (spec §6.5): task-scoped `task_id`/`task_step_key`/`operation_key` columns on `action_intents` plus a minimal `ai_operator_operations` row from P3-1 onward. Record the exact partial-unique predicate and the same-task relaxation of the "key reused by another run" rejection (intentService.ts:1527).
- [ ] Verify the thin slice's execution adapter end to end: `manage_services:restart` is a device command (aiToolsScripts.ts:649), so record how command completion is observed, what a lost acknowledgement looks like, and how the device-command result row is authorized on read.
- [ ] Document each initial recipe's exact supported platforms, input schema, policy mapping, prerequisite reads, accepted result references, and verification criterion.
- [ ] Verify current site visibility and device/ticket move semantics; record fixtures needed for live-DB tests.
- [ ] Establish the safe task DTO/event/export projection; audit #4181 before widening trace detail.
- [x] Inventory legacy trigger/scheduler admission owners and define one durable occurrence identity for cutover to task workflows; list every legacy path the §6.4 sunset contract test will enumerate. (W01 §6: seven owners; each mints its own `dedupeKey` string, guarded by `ai_agent_runs_org_dedupe_key_uq`; the patch scheduler and fleet findings admit none, C1–C3.)
- [ ] Claim a `scheduleRegistry` lane for the coordinator and publisher; confirm the EXPLAIN-as-`breeze_app` contract test harness (`deviceEventsFeedIndexes.integration.test.ts`) is reusable.

Inspect: services/aiAgents/{runService,runLoop,actVerify,fixWatch,playbookActExecutor}; services/actionIntents; jobs/{intentReleaseWorker,intentOutboxPublisher,scheduleRegistry}; services/aiToolsScripts; services/ticketService; services/patchRebootHandler; current RLS/move integration tests.

PRs (2): (1) docs: adapter contracts, recipe cards, writer inventory, sunset list; (2) test scaffolding: fixtures and the EXPLAIN harness extraction if needed.

Exit: the service recovery workflow has a complete adapter contract and representative success/failure/unknown cases. Other workflows are listed as unavailable until equally complete.

### P3-1 — Thin vertical slice: one task, one recipe, approval continuation

Goal: prove acceptance scenario 3 (spec §13) before the full task model exists, so the coordinator, outbox, claim, and verification contracts are learned on real code rather than designed twice. Per the quorum, every mechanism the slice's crash tests need lives in the slice; nothing is "deferred to P3-3" if a P3-1 test exercises it.

Scope, deliberately narrow:

- [ ] One recipe: supported service recovery on one device, supervised mode only (intent path; no direct act, no fleet, no trial, no free-text intake). Execution adapter is the device command (`restart_service`); execution reference is the device command id; the domain result is the command completion record.
- [ ] Minimum coherent schema, one migration: `ai_operator_tasks` (spec §11 identity, scope, authority, state, phase, wait reason, lease/`lease_epoch`, budget, deadline, `next_wake_at`, outcome, plus an inline `current_step_key` and bounded `checkpoint` jsonb, with an explicit forward migration to step rows in P3-2); a minimal `ai_operator_operations` (org, task, `operation_key`, `attempt_ordinal`, `intent_id`, `execution_ref_kind`/`execution_ref_id`, `dispatch_state`, `result_state`, bounded `result`, timestamps); `ai_operator_task_outbox`; the three nullable task columns on `action_intents` with all-or-none CHECK and the live-only partial unique on `(org_id, task_id, operation_key)`; the three nullable task-linkage columns plus CHECK, `prompt_version`, and `resolved_model` on `ai_agent_runs`. All §11.1 indexes for these tables, RLS (the outbox is deliberately RLS-scoped, never `INTENTIONAL_UNSCOPED`, C20), DEFERRABLE composite FKs, `CORE_ORG_CASCADE_DELETE_ORDER` for all three tables, export-policy entries for the three `action_intents` and five `ai_agent_runs` columns (H5), leave-for-erasure dispositions plus a fencing merge executor (baseline §9.3), and the device-move detach hook, in the same PR. Migration name must sort after `2026-10-13-110000` (C16).
- [ ] Identity: task-linked intents derive `idempotency_key` from task identity so the existing `action_intents_org_idem_uniq` index is the single arbiter (C6); the operation row, written in the same transaction as the intent, carries permanent uniqueness on `(org_id, task_id, operation_key)` as the sequential-replay guard (C7); the same-task relaxation of the reuse rejection ships only with the live-authority recheck at the dispatch claim (C8); contract test that a task-linked admission never yields a null `operation_key` (H4).
- [ ] Claim: extend the existing `approved → executing` CAS (intentReleaseWorker.ts:676) with task state, revision, deadline, authority, and `lease_epoch`; extend the kill-switch reversal (:139) and cancellation (intentService.ts:2044) so a task-linked `executing` intent has one owner and cancel-during-execution records in-flight. No run-level cancel exists (C17): a cancelled task fences its in-flight run at the next tool call and lets it finish.
- [ ] Results: the operation row stores the execution reference at dispatch and the result on arrival in their own writes, independent of the intent's status CAS; the reaper's `failed:execution_lost` and the losing-CAS path (intentReleaseWorker.ts:1054) both land on the operation row instead of being dropped.
- [ ] Terminal publication: `intent_completed`/`intent_failed`/`intent_rejected` outbox events from the release worker, the expiry reaper including `reapStaleExecutingIntents`, and the approvals rejection path (routes/approvals.ts:992-994), the two of which publish nothing today (C18); contract test pinning all writers in baseline §3 reachable by a task-linked intent.
- [ ] Coordinator: lease CAS with `lease_epoch`; two typed waits (`approval`, `execution`); wake acknowledged only after the task transition commits; bounded polling from `next_wake_at`; recovery scans over queued-past-wake, waiting-past-wake, running-past-lease, and terminal-with-unsettled-operation; results from a superseded epoch accepted under their original identity; one new run from the checkpoint when verification fails; the `submit_task_step` outcome tool.
- [ ] Verification: criterion = `verifyServiceRunning` (independent `list_services` read, never the dispatch result, C10) plus the alert watch reaching `held_qualified`; a task-specific eligibility gate because `isFixWatchEligible` requires `modeAtStart === 'act'` and `watchReleasedIntent` auto-credits without an `alertId` (C11); an explicit `freshness_seconds` on the criterion because none exists today (C9); typed passed/failed/inconclusive.
- [ ] UI: `/operator/tasks/:taskId` read-only detail (objective, target, state, wait reason, linked runs, intents, operation and result, verification) and a "Delegate to Operator" action on the device page and alert detail. Approvals go through the existing inbox with task provenance. No workspace home yet. The device page shows task-linked work as a read-only feed (#5022, first cut).
- [ ] Metrics from §11.2 wired from day one; sub-hourly ticks below the `scheduleRegistry` threshold, hourly reconciler pass on a lane; kill-switch fencing on admission and dispatch claim.
- [ ] Feature flags: `AI_OPERATOR_TASKS_ENABLED` plus a per-recipe flag, both off by default. Internal and test orgs only (decision D2).

Not in this wave: targets, steps, and events tables; pause/handoff/retry; task-wide budgets beyond the existing run budget; direct-act operations; fleet; trial; task drafts; workflow configurations.

PRs (5): (1) schema, RLS, registrations, indexes, EXPLAIN contract, reference lifecycle hooks for device move and org merge; (2) intent identity columns, task-scoped creation, claim/kill-switch/cancel extension, operation result persistence; (3) outbox events and writer contract test; (4) coordinator, run admission, `submit_task_step`, verification, recovery scans; (5) UI and a Playwright data-testid flow for approve-after-browser-close.

Validation: acceptance scenarios 3, 4 (lost Redis delivery), 5 (crash before and after dispatch, after domain result, before checkpoint commit), 7 (inconclusive verification cannot resolve), 12 (`breeze_app` RLS), 13 (existing runs unchanged); duplicate wake delivery; lease reclaim while the original run finishes; reaper race against a slow command; continuation run re-proposing the same operation attaches, never duplicates; cancel during `executing`; device moved between approval and execution.

Exit: on a dev stack, delegate a service recovery, close the browser, approve from the inbox later, restart the API worker mid-execution, and watch the same task reach `completed + verified_resolved` with exactly one device command. Record what the slice taught before P3-2 is planned in detail.

### P3-2 — Task model, ownership, admission, and API

- [ ] Add targets, steps, and events tables with forced RLS/DEFERRABLE composite FKs and the §11.1 indexes in their creating migrations; migrate P3-1's inline `current_step_key`/`checkpoint` to step rows; widen `ai_operator_operations` with plan revision, argument digest, and verification state. No intent is recreated and no execution key changes.
- [ ] Add closed shared task/step/checkpoint schemas, explicit lifecycle transitions, origin attribution, source links, and bounded content.
- [ ] Implement task admission with pinned agent, one org, frozen targets/criteria, current requester ceiling where applicable, and client idempotency.
- [ ] Add task-wide limits/reservations as policy snapshot v10 with compatible v9 readers; count parent/child work without budget resets.
- [ ] Extend trusted internal run admission with task binding and stable step/attempt identity; separate `lease_epoch` fencing from `attempt_ordinal`. Task-linked enqueue-failure reclaim retains pinned identity and charges once.
- [ ] Generalize the P3-1 lease CAS and typed waits/deadlines; validate same-task as well as same-org run/step/target/operation lineage.
- [ ] Register export/erasure, org merge, device/ticket detach, and queued-job erasure behavior for the new tables. Check actual migration ordering before naming new files.
- [ ] Add POST/GET task routes in a separate aiOperator route module; all writes follow existing audit and MFA conventions.

New areas: shared types/validators for aiOperator; db/schema/aiOperatorTasks; services/aiOperator/{taskService,taskTransitions,taskContext}; routes/aiOperatorTasks.

PRs (4): (1) targets/steps/events schema and registrations; (2) operations schema, adoption, and lineage constraints; (3) admission, budgets v10, reclaim; (4) routes and DTOs.

Validation: lifecycle table tests; duplicate admission and lease recovery; budget races and cumulative successor grants; pinned identity; same-org cross-task linkage rejection; inaccessible/moved target; real `breeze_app` cross-org RLS, site scope, cascade/export/merge/move contracts; EXPLAIN contracts for every list and poll query.

Exit: admit, inspect, cancel an inert queued task; duplicate delivery creates one task/run admission. Existing runs and the P3-1 recipe still pass their contracts.

### P3-3 — Operations, result wakeups, continuation, and stop

- [ ] Add durable operation identity and argument-digest checks; bind direct act/intent/domain execution to one operation owner.
- [ ] Extend intent creation to atomically attach task operation context and persist required wakeup evidence.
- [ ] Extend terminal-result publication and operation result persistence from the two P3-1 writers to every inventoried writer (inline SDK path, stale-execution paths, domain executors); contract test pins writer coverage.
- [ ] Implement coordinator and outbox jobs using the existing queue registry, role split, shutdown, and DB-context patterns; batch size and `SKIP LOCKED` per §11.2.
- [ ] Route each automatic occurrence through one legacy-or-task admission owner; attach repeated evidence and avoid conflicting work across independently created tasks. Land the §6.4 sunset contract test (legacy owner list can only shrink).
- [ ] Resume with fresh bounded runs from typed checkpoints only after the necessary result dependencies complete.
- [ ] Generalize the P3-1 dispatch claim to direct act and domain adapters and add pause/stop/handoff transitions; check expiry, authority tightening, requester access loss, and detached targets.
- [ ] Implement pause, stopping/in-flight observation, bounded confirmed-nonexecution retry, and unknown-effect handoff.
- [ ] Deliver durable deduplicated attention/outcome notifications, authorized owner/team fallback, and visible delivery failures through existing notification infrastructure.
- [ ] Make supported Tier-2 task proposals actionable through the existing intent lifecycle; keep legacy free-form behavior unchanged.

Modify: intent service/terminalization/reapers; aiAgents admission/hooks/finalization; relevant effect adapters. New areas: operationService, taskCoordinator, taskReconciler, task outbox worker.

PRs (5): (1) operation service and digest; (2) writer coverage and reconciler; (3) dispatch claim, pause/stop/handoff; (4) trigger ownership and sunset test; (5) notifications and Tier-2 proposals.

Validation: crash-boundary matrix from spec §13; duplicate/out-of-order events and legacy/task subscriber race; lease recovery while the original run finishes; approval versus execution timing; notification delivery failure; operation digest conflict; successor observation of unknown predecessor effects without new reservation; pause after approval/before dispatch; stop/dispatch races; late results after handoff; budget/circuit/cooldown behavior.

Exit: a delayed approval followed by asynchronous execution and worker restart advances the same task with one logical effect. Unknown execution never causes a blind replay.

### P3-4 — Verification, initial workflows, and trials

- [ ] Implement code-owned workflow registry and availability checks; freeze recipe versions for admitted tasks. Enforce the same pre/post hooks on `submit_task_step` as existing outcome tools.
- [ ] Release investigation and disk recovery adapters with explicit target criteria alongside the P3-1 service recovery recipe.
- [ ] Make verification a typed server result; reuse actVerify/fixWatch only where their evidence satisfies the criterion.
- [ ] Implement configured observation windows (#4204), result freshness, recurrence handling, and terminal handoff packages.
- [ ] Add dedicated trial mode enforced below prompt text; distinguish real investigation from static policy preview; link the builder preview to "Run a trial".
- [ ] Add task-draft interpretation and validation; free text only selects supported recipes/inputs.
- [ ] Exclude trial/proposal-only work from verified fixes, graduation, and realized-value counters.

PRs (4): (1) registry and availability; (2) investigation and disk recipes; (3) verification adapters and windows; (4) trial mode and task drafts.

Validation: successful command with unchanged problem; stale/offline telemetry; absent baseline; dismissed alert; recurrence; trial trying to create an executable intent; unsupported request; malformed model output.

Exit: each released recipe either satisfies its accepted criteria or produces a precise unresolved/handoff outcome. At least one complete recipe passes the P3 evaluation set.

### P3-5 — Operator workspace and initial pilot

- [ ] Build /operator home and complete the task detail with next action, exact target scope, status/phase, per-target results, evidence, cost, and run links.
- [ ] Add workflow discovery and task-first creation; saved workflow configurations use the existing dual-owner policy pattern, with RLS at creation, and can only narrow the effective agent policy (spec §3).
- [ ] Integrate task launch/links into device, alert, finding, ticket, and explicitly requested chat handoff; complete #5022.
- [ ] Reuse existing approval ceremony inline and in inbox; add task/run provenance and exact intent navigation (#4461).
- [ ] Add answer, pause/resume, stop, handoff, and successor retry controls through runAction.
- [ ] Require a reviewed successor under the new requester's ceiling after authority loss; changing human owner alone cannot resume execution.
- [ ] Preserve all current routes/fragments, org-scope behavior, localization, and existing run-result distinctions.
- [ ] Provide setup instructions for partner baselines and unavailable workflows without implicitly enabling policies.
- [ ] Set alert thresholds for the §11.2 metrics from pilot data and record them in the runbook.
- [ ] Run the P3 controlled pilot and publish workflow completion, uncertainty, cost, and intervention results.

PRs (4): (1) workspace home and detail completion; (2) creation flow and workflow configurations; (3) integration points and deep links; (4) controls, pilot instrumentation, runbook.

Validation: task UI interaction tests; mutation-feedback and locale checks; Playwright data-testid flows for trial, late approval, refresh/restart, scope change, stop, handoff and retry; existing deep links.

Release gate: all applicable spec acceptance scenarios pass for the released single-device scope, including durable attention and trigger cutover; metrics and thresholds live; no fleet or customer-send claim yet.

## 5. Phase 4: fleet and patch operations

### P4-0 — Existing executor readiness

- [ ] Extract the full policy-driven patch-job creation service from routes/configurationPolicies/patchJobs; retain buildPatchesSnapshot, ring/site/window settings, and queue failure behavior.
- [ ] Validate patchJobExecutor, patchSchedulerWorker, services/patchRebootHandler, and fleetFindings dispatch/result references end to end.
- [ ] Establish per-target installed/failed/skipped/deferred/reboot-pending/unknown distinctions.
- [ ] Add immutable reviewed per-device update identities/versions alongside existing policy snapshots; intersect with current eligibility inside the actual device executor.
- [ ] Define the single owner of each patch schedule occurrence and adoption of existing jobs; test collisions with manual tasks before rollout.
- [ ] Do not adopt the generic deploymentEngine unless its route/service state mismatch (`routes/deployments.ts:65` versus `deploymentEngine.ts:503-518`) is resolved and `shouldPauseDeployment` is proven to run in a production path.
- [ ] Define executor cancellation capabilities and authoritative late-result reconciliation.

PRs (3): (1) patch-job service extraction; (2) per-target result model and update-set freezing; (3) occurrence ownership and cancellation.

Exit: existing executors provide truthful task adapters. This wave does not enable AI fleet act mode.

### P4-1 — Canary coordination and shared exposure (#4173)

- [ ] Add frozen same-org target cohorts and root-task accounting; individual device runs stay device-bound.
- [ ] Reserve projected exposure using the existing enforcement ledger/locking semantics and stable operation identities.
- [ ] Implement canary → result/verification/hold → widen transitions with bounded concurrency and a nonzero executed-and-verified canary quorum.
- [ ] Halt widening on failure/unknown; display offline/deferred targets separately; never divide by unattempted fleet size.
- [ ] Prove ownership/policy/window changes, cancel, and budget exhaustion halt future cohorts.

PRs (3): (1) cohorts and exposure reservation; (2) canary/hold/widen coordinator; (3) halts, UI, and pilot.

Validation: one failed canary in a large fleet; all-skipped/zero-attempt canary; unknown completion; zero-device exposure allowance; double-reservation races; child-budget exhaustion; membership changes; coordinator restart.

Release gate: successful supervised cohort pilot and required real-partner evidence before unattended widening.

### P4-2 — Sweep findings to tasks (#4442)

- [ ] Preserve read-only sweeps and existing evidence/allowlist checks; keep `hasScope → human_required` (intentService.ts:519) and add a typed child-admission path beside it.
- [ ] Add stable finding identity, active-task dedupe, typed child admission, and parent outcome links.
- [ ] Revalidate targets/evidence at child admission and dispatch; apply root/org budgets and exposure.
- [ ] Ship supervised child tasks first; implement narrowly scoped unattended admission only after P4-1 gates.

PRs (2): (1) finding identity, dedupe, supervised child tasks; (2) gated unattended admission.

Validation: recurring finding attaches to one task; moved target cannot execute; parent completion does not imply child resolution; a scoped intent outside the supported child contract still requires a human.

### P4-3 — Patch maintenance workflow (#4174)

Sequenced last among execution-expanding waves: it ships reboots to customer machines, is the largest wave, and adds the least over existing patch policies. Recommended to follow T1 and T3 (decision D1, §9).

- [ ] Build recipe orchestration around the existing snapshot/job/scheduler/reboot services.
- [ ] Preflight current ring, update approvals, health, window, device availability, and reboot policy.
- [ ] Execute cohorts with actual per-update results; honor notice, deferral and recovery.
- [ ] Fence per-device install and post-install reboot scheduling through the task dispatch claim; exclude updates published/superseded after review.
- [ ] Reconcile failed/unattempted work before retry; verify inventory and health after any required reboot.
- [ ] Produce a complete per-target exception report/ticket and retain scheduler occurrence identity.

PRs (4): (1) preflight and frozen update scope; (2) cohort execution and reboot fencing; (3) reconciliation and verification; (4) exception reporting and scheduler cutover.

Validation: all targets skipped; partial install requiring reboot; deferred reboot; offline after reboot; missing window; no fresh inventory; new/superseding patch after review; revoked approval; failed canary; cancellation/restart between update and reboot; scheduler/task race and workflow enable/disable.

Release gate: workflow-specific platform/ring pilot results. “Patches fleets” applies only to the combinations that passed.

## 6. Tracks: parallel, individually gated

Each track starts after P3-5 and gates itself. None expands execution scope without its own pilot evidence.

### T1 — Ticket follow-through (#4176)

- [ ] Connect existing triage proposals/drafts to persistent tasks and reply/customer-answer dependencies.
- [ ] Add authorized endpoint subtask linkage for supported recipes without treating ticket prose as device authority.
- [ ] Ship reviewed reply → delivery result → customer answer → verify/resolve or handoff.
- [ ] Add separate AI-attributed customer-send/close paths only for explicitly enrolled categories after acceptance data; retain thread/recipient binding, duplicate protection, and human field provenance.
- [ ] Link reopened tickets to successor tasks; stop on ambiguous identity, conflicting human action or uncertain resolution.

PRs (3): (1) task linkage and reviewed reply loop; (2) endpoint subtasks; (3) gated autonomous send/close.

Validation: duplicate answer/send; rejected draft; human edit between review/send; wrong recipient/thread; customer silent; false resolution; resolved then reopened; linked device moves org.

Exit: the reviewed path works end to end. The issue's autonomous portion remains open until its separate send/close gate passes; PR bodies must state this distinction.

### T2 — Scoped memory and evaluated feedback (#4183, #4180)

- [ ] Add versioned runbook notes with dual-owner RLS, expiry, provenance, corrections, and export/erasure.
- [ ] Retrieve bounded authorized historical outcomes; revalidate references; never replay raw transcripts or treat notes as authority.
- [ ] Create a redacted evaluation corpus with tenant consent/scope, split holdout, versioned prompt/examples, and cost/error metrics.
- [ ] Introduce prompt versioning; admission pins the version from then on (spec §6.2).
- [ ] Release example/prompt changes explicitly, with reversal and regression evidence.

PRs (3): (1) runbook notes; (2) retrieval and context assembly; (3) evaluation corpus and prompt versioning.

Validation: cross-org/site retrieval, expired/deleted notes, hostile device/ticket text, incorrect historical summary, superseded evidence, policy conflict and prompt-version rollback.

### T3 — Measured impact and time/service suggestions (#4177, #4182)

- [ ] Instrument accepted task, run, effect, verification, human intervention, wait, handoff and recurrence timestamps.
- [ ] Extend timeSuggestionService/timeEntryService with stable task provenance and replay-safe reviewed posting.
- [ ] Separate actual labor, AI duration, model spend, service units and estimated avoided work in schema/UI.
- [ ] Add defined resolution/recurrence/cost metrics to impact; do not count retries or child tasks as extra resolved incidents.
- [ ] Link concrete quote/invoice suggestions through existing commercial approval services, without automatic financial sending.
- [ ] Add the operations-report workflow adapter around existing narrative/report materialization and separately verified delivery. Preserve supported schedule context; unsupported ad-hoc report inputs remain unavailable. Delivery retry references the existing artifact and never regenerates/bills it silently.

PRs (3): (1) instrumentation and impact metrics; (2) time/service suggestions and commercial links; (3) operations-report adapter.

Validation: repeated confirmation, already-billed work, no human labor, timezone boundaries, reopened tasks, parent/child double-counting, incomplete observation windows, report artifact success with failed delivery, duplicate delivery retry, unsupported report context and task erasure.

### T4 — Approval access (#4179)

- [ ] Add task/run provenance and exact deep links on mobile, with batch behavior matching web authority and per-item outcomes.
- [ ] Add configurable Slack/Teams notifications linking to the existing authenticated ceremony.
- [ ] Treat native channel decisions as a separate reviewed extension; demonstrate identical identity/tenant/step-up/four-eyes/expiry/replay guarantees before enabling.

PRs (2): (1) mobile parity and links; (2) Slack/Teams notifications (native decisions are a later, separately specced item).

Validation: stale/forwarded links, changed membership, expired approval, duplicate decision, mixed-authority batch, secret-free notification and return navigation.

### T5 — Optional automatic promotion (#4175)

- [ ] Use T2/T3 and existing graduation evidence to define a fixed eligible operation set and minimum verified history.
- [ ] Add explicit partner ceiling + per-org enrollment, finite authority, immediate demotion and audit.
- [ ] Test races with failure/recurrence, revocation, policy change, stale snapshots and zero/insufficient evidence.
- [ ] Release only after evidence supports the enrolled cohort; retain human promotion as the default.

PRs (2): (1) eligibility and enrollment; (2) promotion, demotion, audit.

This optimization does not block core Operator completion. It must not silently turn current recommend-only graduation into automatic authority.

## 7. Cross-wave engineering requirements

- Every schema wave includes new idempotent migrations, forced RLS, composite tenant constraints, coverage registrations, drift checks, and live `breeze_app` contracts. Never defer policies to a later wave or edit shipped migrations.
- Every polled or list query on a new table ships with its partial index (spec §11.1) and an EXPLAIN contract test run as `breeze_app` with `enable_seqscan = off`. State columns are `text` with CHECK, never `pgEnum`. Partial-index predicates are literals in the `sql` template, never interpolated or `eq()`-bound values.
- Hourly-and-coarser repeatables register in `jobs/scheduleRegistry.ts` on a free lane; sub-hourly ticks stay below `COARSE_REPEAT_INTERVAL_MS`; no bare `every: 24h`. Pollers batch with `FOR UPDATE SKIP LOCKED` and release the connection before waiting (spec §11.2).
- New migrations sort after `2026-10-13-110000-scripts-security-acknowledgement.sql` and are re-checked against `origin/main` at push (C16). The task outbox is RLS-scoped by design and never joins `INTENTIONAL_UNSCOPED` (C20).
- Every new table follows the spec §11.3 reference lifecycle matrix: no hard FK to device-denormalized or merge-repointed tables, DEFERRABLE composite org FKs, append-only tables in `AUDIT_ADMIN_REQUIRED_TABLES`, dual-owner tables with the SELECT-only partner-wide policy.
- The §11.2 metrics are exported from the first coordinator PR, and thresholds are recorded before the P3 release gate.
- Every queue change enters the existing queue/subscriber/worker lifecycle registry, role split, shutdown, lock, and erasure contracts.
- All task/intent/execution identities survive delivery retries; uncertain effects never receive an automatic fresh identity.
- Task-linked runs record prompt and model identifiers; drift within a task is visible, never silent (spec §6.2).
- Legacy trigger paths have a sunset: one release after a recipe passes its gate, the legacy owner is removed and the contract test's legacy list shrinks (spec §6.4).
- Keep raw model/tool text out of public DTOs, outbox payloads and notifications; authorize evidence references on every read.
- Task result records survive notification/learning failures; durable scheduler identity must survive worker crashes. Side-channel writes cannot erase facts about effects.
- Web mutations use runAction; transient UI state uses hashes; tests follow repository placement and data-testid conventions.
- Run focused unit/contract tests per wave; integration tests need a real DB. Do not infer production task quality from mocked test counts.
- Prepare migration/rollback compatibility before enabling any new worker/recipe. Rollback fences new execution and preserves read-only reconciliation/history.
- When opening implementation PRs, use normal Breeze branch/title conventions and `Closes #<sub-issue>`; merge through the merge queue (`gh pr merge <N> --squash`, never `--admin`). Close an existing roadmap issue only when its full scoped deliverable is verified; partial PRs explicitly identify remaining scope.

## 8. Program completion checklist

- [ ] At least the released investigation/remediation recipes complete through approval, asynchronous execution, verification and handoff without requiring an open chat.
- [ ] Operator workspace accurately shows task ownership, current action, evidence, pending decisions and partial outcomes.
- [ ] Supported fleet and patch recipes enforce canary/hold/widen, shared budgets/exposure, real result verification and clear exceptions.
- [ ] Reviewed ticket completion works end to end; any autonomous reply/closure claims match enabled, evaluated categories.
- [ ] Memory is scoped and correctable; improvements are evaluated/versioned; actual impact is distinguished from estimates and billing.
- [ ] Coordinator and outbox metrics are live with recorded thresholds; no legacy trigger path remains for a gated recipe.
- [ ] Per-workflow pilot evidence and limitations are recorded, including unresolved cases and human interventions.
- [ ] Marketing claims and setup documentation describe the workflows customers can actually enable and finish.

No elapsed-time estimate is assigned before P3-0 validates adapter readiness. The dependency order and measurable exits define scope; discovering an incomplete domain executor creates explicit prerequisite work, not an excuse to mark a task complete on dispatch.

## 9. Decisions

- **D1 — Patch maintenance ordering.** Adopted as recommended on 2026-09-07. Recommended: P4-3 after T1 and T3 as a product sequencing preference, because it carries the highest blast radius (reboots on customer machines) and the smallest delta over existing patch policies. This is not a technical dependency (quorum disagreement, accepted): P4-3's hard prerequisites are P4-0, P4-1, T3's instrumentation subset (task, effect, verification, and intervention timestamps), and its own pilot evidence. Alternative: keep it directly after P4-1 as the roadmap implies. Product call.
- **D2 — Thin slice exposure.** Adopted as recommended on 2026-09-07. Recommended: P3-1 ships behind flags to internal/test orgs only and is not a marketed release; the first customer-facing claim waits for P3-5. Alternative: enroll one friendly partner at P3-1 for earlier feedback.
- **D3 — Operation identity in the thin slice.** Settled by the 2026-09-07 quorum: intent ids alone are not a safe reference because intent idempotency is run-scoped and live-only (intentService.ts:1182, :1476, :1527). P3-1 reserves task-scoped identity on `action_intents` and writes a minimal `ai_operator_operations` row (spec §6.5). Listed here so P3-0 confirms the exact predicate before P3-1 is registered.
