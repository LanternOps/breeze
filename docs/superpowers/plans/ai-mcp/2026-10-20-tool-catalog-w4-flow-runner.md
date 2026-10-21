---
tracking_issue: LanternOps/breeze#5215
wave: W04 (#5219) — flow runner, manual/schedule/event triggers, Tier-3 approval pause/resume, pre-approval (rule 4) + enable (rule 7), runs UI (PR A shared + API, PR B web)
---

# Tool Catalog — Wave 4: Flow Runner, Triggers, Approval Pause/Resume, Runs UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tech enables a W03 draft flow (pre-approving its eligible script step), the flow fires from a schedule, an event, or a Run-now click, runs end to end under its own principal, parks on its sensitive Tier-3 step until a human approves in the existing inbox, and the run is readable as a step timeline.

**Architecture:** Enabling a flow publishes an immutable `flow_versions` row (definition snapshot + per-step pins + pre-approval bindings); runs pin that row, so later edits never change a run. A run is an org-scoped `flow_runs` row (one org, always) with a `flow_run_steps` ledger. One BullMQ queue `flow-runs` executes a run slice at a time under a new `flow` principal (org-scoped DB context, `userId` null): each step is rendered, re-validated unmasked, ownership-checked against the run org, then executed through `executeTool` / `executeTenantToolDetailed` / the in-process built-ins. A Tier-3 step that is not pre-approved becomes an `action_intents` row with `source = 'flow'` and `requesting_flow_run_id`; the **existing** approval inbox, decide path, expiry reaper and `intentReleaseWorker` handle it, with a flow-aware dispatch claim that refuses drifted work; the intent's terminal transition wakes the run. Triggers: manual (route, UI, `run_flow`), a 60-second schedule tick modelled on `aiAgentSweepScheduler`, and a durable `flow-event-trigger` subscriber that may only be enabled when the deployment delivers events durably. A 60-second reconciler is the restart/lost-enqueue backstop.

**Tech Stack:** TypeScript, Zod 4, Hono, Drizzle (queries only), hand-written SQL migration, Postgres forced RLS, BullMQ, Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` — §6.1 (triggers, built-ins), §6.3 rules 4 and 7, §6.4 (`flow_runs`, `flow_run_steps`), §6.5 (runner, identity, checkpointing, drift, loop prevention, execution org, event prerequisite, limits), §6.7 (runs page; budgets are a W05 seam only), §6.8 (runs tab, pre-approval toggle, enable), §8, §9. Roadmap row W04: `2026-09-07-tool-catalog-flows-roadmap.md`. W03 plan (as-built base): `2026-10-17-tool-catalog-w3-flows-document-validator.md`. **Task A0 amends the spec** with the decisions below, each marked **Amendment (W4 plan, 2026-10-20)**.

**Dependencies:** W03 (#5218) merged (PR A #9143, PR B #9432 — on main at `920c32fc6d`). No open PR touches `services/flows/**`, `flowValidator.ts`, or `aiToolsFlows.ts`. Open PRs hold migration prefixes `2027-01-02-110000`, `120400`, `120500`, `140000`; this wave takes `150000`.

## Global Constraints

- **Rigor: high** (new tenant tables, new principal kind, approval lifecycle change, unattended Tier-3 execution). Red test first in every task; a test written after its code does not count. Tenancy, principal, approval and pre-approval tasks get an Opus reviewer.
- **Tests:** API `cd apps/api && npx vitest run <file>` (exact paths; never `pnpm --filter … test -- --run <path>`; vitest path filters are substring matches); shared `cd packages/shared && npx vitest run <file>`; web `cd apps/web && npx vitest run <file>`. A run reporting 0 tests is a stall, not green. `--pool=threads --maxWorkers=2` on a loaded host.
- **Typecheck:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` — read `exit=`; never pipe tsc to `tail`. Shared: `cd packages/shared && npx tsc --noEmit; echo "exit=$?"`. Web: `cd apps/web && npx astro check`.
- **Integration suites** (fail only under CI "Integration Tests", never "Test API"): per-worktree stack (`pnpm wt-stack up`; copy root `.env` with AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` + `BREEZE_CADDY_IP`), then `cd apps/api && npx vitest run --config vitest.integration.config.ts <file>`; `pnpm wt-stack down` afterwards and say so.
- **Migration:** exactly one, `apps/api/migrations/2027-01-02-150000-flow-runs.sql`. Re-check `ls apps/api/migrations | sort | tail -3` before committing; keep the prefix unless `scripts/check-migration-naming.sh` rejects it (then the next free `HHMMSS` that day, said in the PR). Idempotent (`IF NOT EXISTS`, guarded `DO $$`, `DROP … IF EXISTS` + `ADD`); no inner `BEGIN;`/`COMMIT;`; explicit `ON DELETE` on every FK; **every FK that references an `org_id` column (and every `org_id` FK) `DEFERRABLE INITIALLY IMMEDIATE`**; policies in the same file as the tables; **no DML** (no permission rows, no backfill — `flows` gains only nullable columns), so no `set_config` line; then `pnpm db:check-drift`.
- **Registries (grep, don't judge):** `flow_versions` → `DUAL_AXIS_TENANT_TABLES` **and** `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`rls-coverage.integration.test.ts` L501 / L912); `flow_runs`, `flow_run_steps` are shape 1 (auto-discovered — no list entry). All three → `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:257`; `flows` is at L684), `CORE_TENANT_EXPORT_POLICY` (every column; every jsonb `excludedOpen`), `orgMergeRegistry.ts`. New columns on `flows` and `action_intents` (both org-cascade tables) get export classifications. No table in this wave has a `device_id` or `ticket_id` column (the trigger device lives in `trigger_payload`), so no device/ticket list entry — Task A3 asserts this so a later column add is a conscious decision.
- **Names / values (verbatim):** run statuses `queued | running | waiting | awaiting_approval | completed | failed | cancelled | expired`; step statuses `running | awaiting_approval | completed | failed | skipped | unknown_outcome | cancelled`; trigger kinds `manual | schedule | event` (+ `webhook | tool` allowed by the CHECK for W05, never written in W04); `triggered_via` `ui | api | ai_tool | mcp | scheduler | event`. Limits (spec §6.5): 50 steps, 500 items per for-each, run active wall-clock 3,600 s (excludes `waiting` and `awaiting_approval`), per-owner active-run cap 1,000, chain depth ≤ 3, output stored ≤ 262,144 bytes with a truncation marker. `FLOW_APPROVAL_TTL_HOURS` default 24.
- **Feature flag:** everything stays behind `FLOWS_ENABLED` (default `false`). Off ⇒ no schedule tick enqueues, the event subscriber returns immediately, the runner fails any dequeued job's run with `flows_disabled` (never executes a step), new routes 404 after auth (W03 order: `authMiddleware` → scope → flag 404 → permission), new AI tools not declared, MCP list/call gated through `isToolEnvGatedOff`.
- **Permissions:** `automations.read` (runs list/detail, `list_flow_runs`, `get_flow_run`), `automations.write` (run, cancel, enable, disable, `run_flow`, `cancel_flow_run`); partner-wide writes also `canManagePartnerWidePolicies(auth)`. No new permission rows.
- **Public repo:** no customer names, hostnames, or IPs in code, fixtures, or PR text.
- **Branches / PRs:** branch `feature/5215-tool-catalog-flows/wave-5219` off fresh `origin/main`. PR A (Tasks A0–A12) → main, body `Part of #5219`. PR B (B1–B5) stacks on PR A ⇒ **no CI** until `gh workflow run CI --ref <branch>`; body `Closes #5219`. Merge with bare `gh pr merge <N>` (queue; never `--admin`). Feature-lifecycle: `start_wave` before A0, `complete_wave` after PR B merges.

## Open Decisions (Gate B)

Each lists the plan's default in **[brackets]**; the tasks are written to the default. Todd may overrule any before execution; the affected tasks are named. Quorum positions are in § Quorum.

1. **Run tables' tenancy shape.** The dispatch brief said runs "must follow `flows`" (org XOR partner, partner-wide SELECT). **[`flow_versions` follows `flows` exactly (XOR, dual-axis, partner-wide SELECT, owner copied from the flow by a constraint trigger); `flow_runs` / `flow_run_steps` are shape 1 — `org_id NOT NULL`, no partner axis; on org merge runs and steps are `leave-for-erasure` with an immutable `org_id`, and the loser's active runs are cancelled in the resolve phase.]** A run always executes in exactly one org under an org-scoped principal (spec §6.5 "a run always belongs to exactly one org"; spec §8 already says shape 1). A partner-wide SELECT branch on runs would hand every org token of the partner any org-less run's rendered inputs and outputs; with `org_id NOT NULL` there is no such row. Partner users still see runs of every org they can access through `breeze_has_org_access`. Precedent: `backup_provider_devices` (NOT NULL `org_id`, no second read branch, `rls-coverage.integration.test.ts` ~L440). Merge: `action_intents.org_id` is trigger-immutable and intents are `leave-for-erasure` (`orgMergeRegistry.ts:276`), so a run referenced by an intent through the composite FK cannot move either — the `ai_agent_runs` decision (`orgMergeRegistry.ts:277-286`, run history stays with the source org) applied to flow runs (quorum Q1). W05's webhook `org_unresolved` miss is recorded in its delivery log, not as a partner-level run. Alternative: XOR on runs — rejected for the leak above and because no W04 trigger produces an org-less run. Affects A2, A3, A12.
2. **Definition snapshot.** **[`flow_versions` table: one immutable **publication** row per enable (`publication_seq` per flow, never reused — re-enabling unchanged content still publishes a new row because the delegator, pins and bindings can differ); runs FK it; `flows.enabled_publication_seq` points at the live one (no circular FK).]** It also holds the enable-time step pins and pre-approval bindings, which is where drift is measured. `definition_version` (bumped by every draft save) is recorded on the publication but is not its identity (quorum Q1). Alternative: copy `definition` into every run (simpler, duplicates up to 256 KB per run, no home for bindings). Editing stays W03's rule widened by one state: a flow is editable unless `status = 'enabled'` (a `paused` or `disabled` flow can be edited and re-enabled; re-enable publishes a new row). Affects A2, A6.
3. **Pre-approval lane (rule 4).** **[The act-mode asset lane only: a step is pre-approvable iff its tool is `run_script`, `scriptId` is literal, `groupId` is absent, the script has no tenant-variable parameter bindings, its approval scope is `supervised` (never `four_eyes`), and the rendered target count is exactly 1 device. The binding is a SHA-256 of the script's content material (`runScriptDigestMaterial` minus `deviceOrgIds`) stored on the publication; a mismatch at run time is `binding_drift` and pauses the flow. Execution is a direct `executeTool` with a `verifiedRunScript` pin — no intent.]** Variable-dependent scripts are refused (`variable_dependent`) because rotating a tenant variable changes what runs without changing the script body (`runScriptSnapshot.ts:23-30`); pinning live variable values per execution org is a W05 option (quorum Q5). The policy-decidable effect-pin lane (`POLICY_DECIDABLE_TIER3`, `attemptPolicyDecision`) is deferred: its exposure reservations are keyed to AI agents (`services/actionIntents/policyDecide.ts:291`, `runAuthorizeTransaction`), and `requiresEffectPin` / `maxTargetCardinality` have no runtime consumer yet. Pre-approval is never in the document (W03's `pre_approval_not_available` stays); it is set at enable by an interactive user. Affects A6, A7.
4. **When pre-approvals are honoured.** **[Only for `schedule` and `event` runs and for manual runs started by an interactive user session (`triggered_via = 'ui'`). Runs started by `run_flow` (chat, after `run_flow`'s own Tier-3 tap — Decision 11) or by an API key park every Tier-3 step for approval.]** AI- or key-initiated runs can never cause an unattended Tier-3 effect; recorded per run as `pre_approvals_honored`. Affects A8, A9, A11.
5. **Who executes an approved Tier-3 step.** **[The existing `intentReleaseWorker` (`releaseApprovedIntent`), behind a new flow-aware dispatch claim, not the runner.]** Release already owns revalidation, effect digests, the execution lease and `execution_lost` reaping; the claim (modelled on `aiOperator/dispatchClaim.ts:154`) adds the flow drift checks, and `revalidateRelease.ts` branch (e) (~L500, today agent-only) gains a structural flow-authority branch. A lost `approved → executing` CAS (another dispatcher won, duplicate delivery) is a silent no-op, never a drift cancel; a release that ends `execution_error` with `executed: true` or `execution_lost` (`intentExpiryReaper.ts` `reapStaleExecutingIntents`) makes the step `unknown_outcome` and fails the run regardless of `onFailure` (quorum Q4). The runner copies `action_intents.result` into the step output on wake. Alternative: runner claims and executes (duplicates release revalidation). Affects A5, A8.
6. **Approver pool for flow intents.** **[Agent-origin semantics in both fan-out **and** decide authorization (supervised ⇒ action-and-target-eligible pool, `isAgentIntentDecideAuthorized` rather than the requester rule that would answer `not_requester`; four_eyes ⇒ `approvals:decide` pool), with the run's **publication** `enabled_by_user_id` excluded from the four-eyes pool — new logic, since the agent branch has no requester to exclude — and, like the agent branch, no sole-operator fallback.]** The delegator may approve a supervised step of their own flow (spec §6.5) and can never be the second pair of eyes on a four-eyes step; a four-eyes step in an org where the delegator is the only approver fails the run `no_eligible_approvers` rather than self-approving. Affects A5.
7. **Run-time principal and the delegator.** **[New `PrincipalKind { kind: 'flow'; flowId; runId }`; no user RBAC at run time (spec D4); per-step policy checks including approval-scope drift. Every site that branches on `principal.kind === 'ai_agent'` is classified, not blanket-converted: "not a human / no RBAC token / no approval surface" sites move to `isAutomationPrincipal()`; sites that need agent identity (ticket actors `aiToolsTicketing.ts:93`, workspace run resources `workspaceTools.ts:56`) stay agent-only and refuse a flow principal explicitly; pinned by a contract test. A deactivated or deleted delegator pauses the flow (`delegator_inactive`), checked at every run slice start (incl. resume) and in the approval dispatch claim.]** The delegator clause deviates from spec §6.5 ("the enabling user leaving does not stop runs"): an offboarded or compromised account must not keep delegated automation alive, including work already parked; an admin re-enables under a new delegator in one click, audited (quorum Q6 agreed). Alternative: keep spec behaviour and only flag it in the UI. Affects A4, A5, A8.
8. **Concurrency.** **[≤ 1 `running` run per (flow, org) — parked (`waiting`, `awaiting_approval`) runs do not hold the slot — and ≤ `FLOW_MAX_RUNNING_PER_OWNER` (default 20) per flow owner; no slot ⇒ the job is delayed 15 s without consuming an attempt. Active cap (queued + running + waiting + awaiting_approval) 1,000 per owner at creation.]** Spec "one concurrent run per flow" read per org so a partner-wide schedule's fan-out does not serialize across hundreds of orgs. The slot is a throughput limiter, not mutual exclusion of effects: an approved step released by `intentReleaseWorker` for a parked run executes outside the slot (Codex asked for the release to take the slot; rejected because holding a runner slot from inside the release worker couples two queues' leases for no safety gain — a flow that needs serialized effects keeps its Tier-3 steps un-pre-approved, and per-device serialization is the agent's command queue). Affects A8, A9.
9. **Dedupe permanence and retention.** **[`UNIQUE (flow_id, org_id, dedupe_key)` without a status predicate; run and step rows are never deleted in W04 — after `FLOW_RUN_RETENTION_DAYS` (default 90) a retention job nulls `trigger_payload`, `inputs`, `rendered_input` and `output` (marking `bodies_pruned_at`), the `jobs/aiToolOutputRetention.ts` precedent.]** Spec §6.4 said "while status in (queued, running, awaiting_approval)", which lets an at-least-once event redelivered after the first run finished run again. Deleting shells is impossible anyway while an intent references the run (`ON DELETE RESTRICT`, intents are retained). Shell volume is bounded by W05's monthly caps. Affects A2, A8, A9.
10. **Event trigger precondition.** **[Enable requires `eventDispatchMode() === 'enforce'` **and** `eventDispatchQueueSubscribers().has('flow-event-trigger')`; the reconciler re-checks on every pass and pauses enabled event flows `event_dispatch_not_durable` if the deployment stops delivering durably.]** In `shadow`, and in `enforce` without membership, delivery is in-process, at-most-once, and handler failures are swallowed (`eventBus.ts` `invokeLocalHandlers`); W03's validator only warned on `off`. **Known limitation, documented not solved:** a failed route-enqueue at publish time drops the event before any subscriber sees it (`eventDispatchQueue.ts:12`, the platform's "not-an-outbox gap"); flows inherit it. Affects A6, A8, A9.
11. **AI tools and the index budget.** **[`run_flow` **Tier 3** (`automations.write`, agent human-only), `list_flow_runs` (T1), `get_flow_run` (T1), `cancel_flow_run` (T2, `automations.write`, agent human-only). No `explain_flow_run` — `get_flow_run`'s step ledger is what the model explains from. Apply the already-approved 6.75 KB ceiling (6912 B; spec §11 W3 row, Todd 2026-10-20) — W03 measured 6625 B flag-on and these names add ~57 B.]** Spec §6.6 makes invoking a flow carry the flow's effective tier; a static Tier-2 wrapper would let an MCP `ai:write` key start a Tier-3 flow past MCP's approval gate (quorum Q7). Per-flow tiers need an async tier resolver in chat and MCP, which is what W05's `flow__<slug>` registration builds; until then `run_flow` takes the upper bound — one human tap to start any flow from chat, never from MCP. No `enable_flow` AI tool: enabling is the delegation decision and stays a human UI action. Affects A11.
12. **Built-ins and for-each in W04.** **[Runner dispatches `wait` and `set`. `notify` stays `builtin_not_available` until W05 (it needs the per-flow notification channel W05 adds with budgets). For-each runs sequentially; enable refuses `forEach.concurrency > 1` (`foreach_concurrency_not_available`) until W05.]** Affects A6, A7, A8.
13. **Delegation ceiling.** **[Enable requires the enabling user's access to be unrestricted in the owner scope: no site allowlist (`allowedSiteIds` undefined, `permissions.ts` `canAccessSite`) for an org flow; partner scope with all-orgs access (`AuthContext.partnerOrgAccess === 'all'`, `middleware/auth.ts:186`) and no site allowlist for a partner-wide flow. Otherwise `delegation_scope_restricted`.]** The flow principal is org-wide; a site-limited tech must not mint an org-wide principal by enabling a flow (quorum Q5). Persisting a site ceiling on the publication and enforcing it per step is the alternative — deferred until someone needs site-scoped flows. Affects A6.
14. **Loop prevention beyond `flow.run.*`.** **[The runner and the flow branch of the release worker run tool executions inside an `AsyncLocalStorage` flow context `{ runId, chainDepth }`; `publishEvent` stamps `metadata.flowRunId` / `metadata.flowChainDepth` from it when present; the event trigger inherits `chainDepth + 1` from any event carrying it (and skips the originating flow) — not only from `flow.run.*`.]** Without it, flow → `resolve_alert` → `alert.resolved` → flow loses ancestry (`aiToolsAlerts.ts:412` carries user attribution only; quorum Q3). Affects A7, A8, A9.
15. **Timeouts and late results.** **[`executeTool` takes no `AbortSignal` (`aiTools.ts:601`), so a step timeout cannot stop the call. The runner holds a durable lease (`flow_runs.lease_token` + `lease_expires_at`, renewed at every checkpoint); every checkpoint write is conditional on the lease, so a late result from a timed-out or superseded slice is discarded. A Tier-1 timeout fails the attempt (and may retry); a Tier ≥ 2 timeout is `unknown_outcome`.]** The heartbeat-only reaper design has the race the agent reaper documents (`aiAgents/runService.ts` ~L882; quorum Q2). Affects A2, A7, A8.
16. **PR shape.** **[Two PRs as dispatched: PR A shared + API, PR B web.]** The roadmap row said three (runner+tables, triggers, web). PR A is large; if the reviewer asks, split after Task A8 (A0–A8 runner + approvals, A9–A12 triggers + routes + tools) — both halves keep CI green because triggers only add callers.

## Quorum

Codex `xhigh` (gpt-6-astra, read-only, 2026-10-20) on eight questions with the author's positions stated. Every citation it gave was re-read in source before acceptance (`orgMergeRegistry.ts:276`, `eventDispatchQueue.ts:12`, `flows/repository.ts:31`, `permissions.ts` `canAccessSite`, `runScriptSnapshot.ts:23`, `revalidateRelease.ts` ~L500 — all confirmed). Recorded again in Task A0's §11 row and the PR body.

| # | Author position | Codex | Outcome |
|---|---|---|---|
| Q1 | `flow_versions` XOR like `flows`; runs shape 1; snapshot = versions table; runs repoint on merge | **Agree** on shape 1 and versions. **Disagree** on merge: intents are trigger-immutable and leave-for-erasure, so repointing a run an intent references breaks the composite FK. Version ≠ publication: re-enable of unchanged content changes delegator/pins/bindings | Adopted: runs/steps `leave-for-erasure` + immutable `org_id`, loser's active runs cancelled in resolve (Decision 1, A2, A3); `publication_seq` identity (Decision 2, A2, A6) |
| Q2 | One job per slice, row-checkpointed, heartbeat reconciler, permanent dedupe, 90-day delete | **Disagree as written:** needs a durable lease checked at claim and checkpoint; persist `wake_at`; `Promise.race` can't cancel (`executeTool` has no signal) — fence late results; RESTRICT intents block run deletion; cap parked runs too | Adopted: lease + fenced checkpoints (Decision 15), `wake_at`, body pruning instead of deletion (Decision 9), active-run cap (Decision 8). **Not adopted:** release worker taking the runner slot (Decision 8 rationale) |
| Q3 | Enforce+membership gate; `flow.run.*` chain depth; sweeper-style schedule | **Agree** on the gate (re-check after enable). **Disagree** that delivery/loops are covered: route-enqueue failure drops events (documented platform gap); tool-published events lose ancestry; don't copy the sweeper's catch-and-continue fan-out | Adopted: reconciler re-check + pause (Decision 10), known limitation documented, ALS causation (Decision 14), schedule key advances only after every org's admission succeeds (A9) |
| Q4 | Approved steps execute in `intentReleaseWorker` behind a flow claim | **Agree, conditionally:** add a structural flow branch to release revalidation and fix chat/user attribution on tenant releases; extend decide authorization, not just fan-out; `execution_error`/`execution_lost` ⇒ `unknown_outcome`; lost CAS ≠ drift | All adopted (Decisions 5, 6; A5) |
| Q5 | actAssets lane only; content digest; rule 7 by permission name | **Agree** on the lane. **Disagree:** permission names ignore site scope (site-limited enabler mints an org-wide principal); digest omits tenant-variable bindings; `assertFlowSlugAvailable` counts the flow itself | Adopted: delegation ceiling (Decision 13), `variable_dependent` refusal (Decision 3), `excludeFlowId` (A6) |
| Q6 | Flow principal; convert all `ai_agent` sites; pause on inactive delegator at run start | **Agree** on the principal and on deliberate deactivation revocation. **Disagree** with blanket conversion (ticket actors, workspace resources need an agent id); check the delegator at resume and dispatch too; compare approval scope, not just tier | All adopted (Decision 7; A4, A5, A6, A7) |
| Q7 | `run_flow` Tier 2; 4 tools; 6912 B ceiling | **Disagree** on Tier 2: spec §6.6 makes invocation carry the flow's tier; a static Tier-2 wrapper evades MCP's gate. Agrees on dropping `explain_flow_run` and the ceiling | Adopted: `run_flow` Tier 3 until W05's per-flow tier (Decision 11) |
| Q8 | Tabs, enable dialog, run-now, polled timeline, W05 budget seam | **Agree**; UX: distinguish wait kinds, approval/cancel links, stale-poll feedback, poll summaries and lazy-load bodies, no overlapping requests, `useHashTab` doesn't write the hash | Adopted in B2, B3 and A10 (summary/body split) |

Codex's top three risks, each now owned by a task: duplicate/late mutations across recovery, release and timeouts (A5, A8 — lease, fencing, `unknown_outcome`); delegation exceeding the enabler's scope or stale publications keeping authority (A6 ceiling, A5/A8 publication + delegator checks); lifecycle conflicts between immutable intents, org merge, retention and snapshots (A2, A3, A8).

## Review Focus

- **Approving stale work.** A run parked on step `s3` for 20 hours; meanwhile the flow is disabled, edited and re-enabled (new version), or the tenant tool behind `s3` is re-discovered with a new revision. Approving the old intent must never execute: the dispatch claim cancels the intent and fails the run `drift`. (Task A5 test `claim refuses when the flow moved to a new version`, `claim refuses on tenant revision change`.)
- **Worker death mid-mutation.** The process dies after `run_script` was sent and before the step row is closed. Redelivery must not resend: a `running` Tier-2/3 row ⇒ `unknown_outcome`, run failed, nothing executed twice; a Tier-1 row retries. (Task A8 tests `stalled tier-3 step becomes unknown_outcome`, `stalled tier-1 step retries`.)
- **A partner-wide flow touching the wrong org.** An event from org A starts a partner-wide flow; a templated `deviceIds` resolves (through `inputs` or a crafted payload field) to a device in org B. The step fails `reference_not_owned` before any executor runs, and the flow principal's org-scoped DB context would refuse it anyway. (Task A7 test `templated device id outside the run org is refused`.)
- **Event storms and loops.** 300 alerts in a minute on one partner-wide event flow; a flow whose last step resolves an alert that another flow listens for. Dedupe holds per event id, per-(flow, org) serialization holds, the active-run cap refuses past 1,000 with a visible counter, and chain depth stops at 3 — including through ordinary tool events, not only `flow.run.*`. (Task A9 tests `redelivered event creates no second run`, `chain depth 4 is refused`, `own flow.run event is ignored`, `alert event published by a flow step inherits its depth`.)
- **AI-started runs and pre-approval.** `run_flow` from chat on a flow whose `run_script` step is pre-approved must still park that step for a human (after `run_flow`'s own approval tap), and an MCP key cannot start a flow at all. (Task A8 test `pre-approval ignored when not honoured`; Task A11 test `run_flow creates a run with pre_approvals_honored false`.)

---

## File Structure

**packages/shared**
- Create `src/validators/flowRuns.ts` (+ test) — run/step status unions, trigger kinds, `triggered_via`, error codes, DTOs, `FLOW_RUN_LIMITS`, manual-run input schema, enable-request schema; export from `src/validators/index.ts`.
- Create `src/flows/inputs.ts` (+ test) — `coerceFlowInputs(decls, raw)` (manual inputs against `FlowDocumentV1['inputs']`).
- Modify `src/validators/flows.ts` — `FlowIssueCode` += `event_dispatch_not_durable`, `foreach_concurrency_not_available`, `pre_approval_not_eligible`; `FlowDetailDto` += `enabledPublicationSeq`, `enabledAt`, `enabledByUserId`, `pausedReason`.

**apps/api — data + registries**
- Create `migrations/2027-01-02-150000-flow-runs.sql`; `src/db/schema/flowRuns.ts` (`flowVersions`, `flowRuns`, `flowRunSteps`); modify `src/db/schema/flows.ts` (two columns), `src/db/schema/actionIntents.ts` (`requestingFlowRunId`, source/origin unions), `src/db/schema/index.ts`.
- Modify `src/__tests__/integration/rls-coverage.integration.test.ts`, `src/services/tenantCascade.ts`, `src/services/tenantExportPolicyRegistry.ts`, `src/services/orgMergeRegistry.ts`, `src/services/orgMergeCustomExecutors.ts`.
- Create `src/__tests__/integration/flowRunsPartnerRls.integration.test.ts`.

**apps/api — principal + approvals**
- Modify `src/middleware/auth.ts` (`PrincipalKind` `flow`, `isFlowPrincipal`, `isAutomationPrincipal`); create `src/services/flows/flowAuthContext.ts` (+ test); `src/middleware/automationPrincipal.contract.test.ts`.
- Modify `src/services/actionIntents/intentService.ts` (flow source, fan-out, TTL), `actorContext.ts`, `src/services/approvals/decideApprovalRequest.ts` (flow branch of the supervised check), `src/jobs/intentReleaseWorker.ts` (flow claim + wake), `src/services/aiOperator/taskOutbox.ts` (`publishIntentTerminalOutbox` wake hook); create `src/services/flows/intentClaim.ts` (+ test), `src/services/flows/releaseAuthority.ts` (+ test).

**apps/api — runner**
- Create `src/services/flows/versions.ts` (enable/disable/publish), `src/services/flows/preApproval.ts`, `src/services/flows/stepExecutor.ts`, `src/services/flows/triggerScope.ts`, `src/services/flows/runService.ts` (create/cancel/list/get), `src/services/flows/runAdmission.ts` (caps + the W05 budget seam), `src/services/flows/runLease.ts` (lease + fenced checkpoints), `src/services/flows/flowExecutionContext.ts` (ALS ancestry), each with a co-located test.
- Modify `src/services/flowValidator.ts` — export `revalidateRenderedStep`, `stepPinsFor`; `src/services/flows/repository.ts` + `service.ts` — `excludeFlowId` on the slug check; `src/services/actionIntents/revalidateRelease.ts` — flow-authority branch.
- Create `src/jobs/flowRunner.ts`, `src/jobs/flowRunReconciler.ts`, `src/jobs/flowScheduleTick.ts`, `src/jobs/flowRunRetention.ts` (+ tests); modify `src/jobs/queueSchemas.ts`, `src/services/workerRegistry.ts`, `src/jobs/workerReadinessManifest.ts`.
- Create `src/services/flows/eventTrigger.ts` (+ test); modify `src/services/eventSubscriberIds.ts`, `src/services/eventSubscribers.ts`, `src/services/eventBus.ts` (`flow.run.completed`, `flow.run.failed`).
- Modify `src/config/env.ts`, `src/config/validate.ts` (+ tests), compose ×2, `.env.example` ×2 — `FLOW_MAX_RUNNING_PER_OWNER`, `FLOW_RUN_RETENTION_DAYS`, `FLOW_APPROVAL_TTL_HOURS`.

**apps/api — surface**
- Modify `src/routes/flows.ts` (+ test) — enable, disable, runs, run detail, cancel; `src/services/mcpCoverage.ts`.
- Modify `src/services/aiToolsFlows.ts` (+ test), `src/services/flows/toolNames.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts` (`TOOL_PERMISSIONS`), `aiAgentSdkTools.ts` (`TOOL_TIERS`, `flowToolDefinitions`), `aiToolExposure.ts`, `aiAgents/agentToolCatalog.ts`, the registry contract tests, `aiToolIndex.test.ts`, `apps/web/src/components/ai-risk/tierConfig.ts`, the efficiency-baseline doc.

**apps/web**
- Modify `src/components/flows/api.ts` (reads + `runAction` mutations), `FlowDetailPage.tsx` (tabs), `FlowStepList.tsx` (pre-approval badge); create `FlowEnableDialog.tsx`, `FlowRunDialog.tsx`, `FlowRunsTab.tsx`, `FlowRunPage.tsx`, `FlowRunTimeline.tsx`, `useFlowRunPolling.ts` + tests; `src/pages/flows/runs/[runId].astro`; locales ×8 (`flows.json`, `pages.json`).
- Modify `src/components/approvals/ApprovalsInbox.tsx` only if Task B4's test shows the flow context line missing (server labels should suffice).

---

## PR A — Shared + API

### Task A0: Spec amendments

**Files:** Modify `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` (§6.3 rule 4/7, §6.4, §6.5, §6.8, §8, §11).

- [ ] **Step 1:** One **Amendment (W4 plan, 2026-10-20)** call-out per Open Decision as finally adopted (1–15): §6.4 `flow_versions` + shape-1 runs + permanent dedupe + `waiting` / `unknown_outcome` statuses; §6.3 rule 4 lane and eligibility, rule 7 timing; §6.5 release-worker execution of approved steps, flow principal + classified `isAutomationPrincipal` sweep, delegator pause (every slice + dispatch claim), delegation ceiling, per-(flow, org) slot, run lease + fenced checkpoints, event `enforce`+membership precondition and the route-enqueue known limitation, ALS ancestry for loop prevention, reconciler, body-pruning retention, merge = leave-for-erasure; §6.6 `run_flow` Tier 3 until W05; §6.8 the four tools, no `explain_flow_run`, no `enable_flow`; §11 a "Plan amendments (W4)" row naming the quorum outcome.
- [ ] **Step 2: Commit** — `git commit -m "docs(specs): W4 amendments — flow_versions, shape-1 runs, release-worker approvals, act-asset pre-approval"`

### Task A1: Shared run types and manual inputs

**Files:**
- Create: `packages/shared/src/validators/flowRuns.ts`, `flowRuns.test.ts`, `packages/shared/src/flows/inputs.ts`, `inputs.test.ts`
- Modify: `packages/shared/src/validators/flows.ts`, `packages/shared/src/validators/index.ts`, `packages/shared/src/flows/index.ts`

**Interfaces (Produces):**
```ts
// validators/flowRuns.ts
export const FLOW_RUN_STATUSES = ['queued','running','waiting','awaiting_approval','completed','failed','cancelled','expired'] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];
export const FLOW_RUN_ACTIVE_STATUSES: readonly FlowRunStatus[];   // queued, running, waiting, awaiting_approval
export const FLOW_RUN_STEP_STATUSES = ['running','awaiting_approval','completed','failed','skipped','unknown_outcome','cancelled'] as const;
export type FlowRunStepStatus = (typeof FLOW_RUN_STEP_STATUSES)[number];
export type FlowTriggerKind = 'manual' | 'schedule' | 'event';           // DB CHECK also admits 'webhook' | 'tool' (W05)
export type FlowTriggeredVia = 'ui' | 'api' | 'ai_tool' | 'mcp' | 'scheduler' | 'event';
export type FlowRunErrorCode = 'step_failed' | 'rejected' | 'drift' | 'binding_drift' | 'unknown_outcome' | 'run_timeout'
  | 'step_timeout' | 'input_invalid' | 'reference_not_owned' | 'tool_unavailable' | 'tool_blocked' | 'too_many_items'
  | 'render_failed' | 'flow_disabled' | 'flows_disabled' | 'delegator_inactive' | 'no_eligible_approvers' | 'chain_depth_exceeded' | 'worker_lost' | 'cancelled';
export const FLOW_RUN_LIMITS = { maxActiveMs: 3_600_000, maxQueuedPerOwner: 1000, maxChainDepth: 3,
  maxStoredOutputBytes: 262_144, defaultMaxRunningPerOwner: 20, slotRetryDelayMs: 15_000 } as const;
export const flowManualRunRequestSchema;   // { orgId?: uuid, inputs: record<string, unknown> default {}, idempotencyKey?: string 1..64 [A-Za-z0-9_-] }
export const flowEnableRequestSchema;      // { expectedVersion: int ≥ 1, preApprovedStepIds: string[] (≤ 50, FLOW_STEP_ID_RE) default [] }
export interface FlowRunStepDto { id: string; stepId: string; itemIndex: number | null; attempt: number; tool: string;
  toolSource: 'core' | 'tenant' | 'builtin'; tier: 1 | 2 | 3; status: FlowRunStepStatus; approvalMode: 'none' | 'intent' | 'pre_approved';
  hasBody: boolean; renderedInput?: unknown; output?: unknown; outputTruncated: boolean; errorCode: string | null; error: string | null;
  actionIntentId: string | null; approvedByUserId: string | null; startedAt: string; finishedAt: string | null; durationMs: number | null }
export interface FlowRunSummaryDto { id: string; flowId: string; flowName: string; orgId: string; definitionVersion: number;
  triggerKind: FlowTriggerKind; triggeredVia: FlowTriggeredVia; status: FlowRunStatus; errorCode: FlowRunErrorCode | null;
  currentStepId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null }
export interface FlowRunDetailDto extends FlowRunSummaryDto { triggerPayload: unknown; inputs: unknown; error: string | null;
  preApprovalsHonored: boolean; chainDepth: number; publicationSeq: number; wakeAt: string | null; bodiesPrunedAt: string | null;
  definition: FlowDocumentV1; steps: FlowRunStepDto[] }   // steps without bodies; bodies via the step route
export function isTerminalFlowRunStatus(s: FlowRunStatus): boolean;
// flows/inputs.ts
export type CoerceFlowInputsResult = { ok: true; inputs: Record<string, FlowValue> } | { ok: false; issues: Array<{ name: string; message: string }> };
export function coerceFlowInputs(decls: FlowDocumentV1['inputs'], raw: Record<string, unknown>): CoerceFlowInputsResult;
```
`coerceFlowInputs`: unknown keys ⇒ issue; missing `required` ⇒ issue; `number` accepts finite numbers and numeric strings; `boolean` accepts booleans and `'true'|'false'`; `uuid` lowercased and checked; `string` ≤ 4,096 chars; absent optional ⇒ `null` (spec §6.2: missing and `null` both evaluate to `null`).

- [ ] **Step 1: Failing tests** — `flowRuns.test.ts`: `isTerminalFlowRunStatus` true for exactly `completed|failed|cancelled|expired`; `flowEnableRequestSchema` rejects a step id `Bad` and 51 ids; `flowManualRunRequestSchema` rejects `idempotencyKey: 'a:b'`. `inputs.test.ts`: `{ count: '3' }` with `number` ⇒ `3`; `{ count: 'x' }` ⇒ issue; undeclared `extra` ⇒ issue; optional absent ⇒ `null`; uppercase uuid normalised. Run `cd packages/shared && npx vitest run src/validators/flowRuns.test.ts src/flows/inputs.test.ts` → FAIL.
- [ ] **Step 2: Implement**; extend `FlowIssueCode` and `FlowDetailDto` as listed in File Structure.
- [ ] **Step 3: Run** both files + `src/validators/flows.test.ts` + `src/browserSafeBarrel.test.ts` → PASS; shared tsc `exit=0`.
- [ ] **Step 4: Commit** — `git commit -m "feat(shared): flow run statuses, DTOs, enable/run request schemas, manual input coercion (#5219)"`

### Task A2: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2027-01-02-150000-flow-runs.sql`, `apps/api/src/db/schema/flowRuns.ts`, `apps/api/src/db/schema/flowRuns.test.ts`
- Modify: `apps/api/src/db/schema/flows.ts`, `apps/api/src/db/schema/actionIntents.ts`, `apps/api/src/db/schema/index.ts`

**Interfaces (Produces):** Drizzle `flowVersions`, `flowRuns`, `flowRunSteps` (camelCase of the columns below); `flows.enabledPublicationSeq`, `flows.scheduleLastOccurrenceKey`; `actionIntents.requestingFlowRunId`; `source` union += `'flow'`; `ActionIntentOriginPrincipalKind` += `'flow'`.

- [ ] **Step 1: Failing schema test** (`flowRuns.test.ts`): table names; every column listed below present; `flowRuns.orgId` not nullable; no `partnerId` on `flowRuns`/`flowRunSteps`; no column named `deviceId`/`ticketId` on any of the three; `flows.enabledPublicationSeq` and `actionIntents.requestingFlowRunId` exist. Run → FAIL.
- [ ] **Step 2: Write the migration** (sections in this order; model RLS on `2027-01-02-130000-flows.sql`, the action-intents swaps on `2026-09-05-a-agent-originated-intents.sql`, the owner guard on `tool_source_tools_owner_guard_trg` in `2026-10-16-193500-tool-sources.sql`, the run immutability guard on `ai_agent_runs_immutable_guard` in `2026-09-06-a-agent-runs-org-immutable.sql`):
  1. **`flows`**: `ADD COLUMN IF NOT EXISTS enabled_publication_seq integer`, `schedule_last_occurrence_key text`; guarded CHECK `flows_enabled_publication_chk ((status IN ('enabled','paused')) = (enabled_publication_seq IS NOT NULL))` — existing rows are all `draft` (W03 has no enable path), so it validates without DML.
  2. **`flow_versions`** (a publication): `id uuid pk`, `flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE`, `org_id uuid REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, `partner_id uuid REFERENCES partners(id) ON DELETE CASCADE`, `publication_seq integer NOT NULL`, `definition_version integer NOT NULL`, `definition jsonb NOT NULL`, `effective_tier smallint NOT NULL`, `step_pins jsonb NOT NULL`, `pre_approvals jsonb NOT NULL DEFAULT '[]'`, `enabled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`, `created_at timestamptz NOT NULL DEFAULT now()`. CHECKs `flow_versions_one_owner_chk`, `flow_versions_effective_tier_chk (1..3)`, `flow_versions_publication_seq_chk (publication_seq >= 1)`, `flow_versions_jsonb_shape_chk (jsonb_typeof(definition)='object' AND jsonb_typeof(step_pins)='array' AND jsonb_typeof(pre_approvals)='array')`. `UNIQUE (flow_id, publication_seq)`. Constraint trigger `flow_versions_owner_guard_trg` (DEFERRABLE INITIALLY DEFERRED, so org merge's repoint order does not matter): `(org_id, partner_id)` must equal the parent flow's. BEFORE UPDATE trigger `flow_versions_immutable_trg`: raises if `flow_id`, `publication_seq`, `definition_version`, `definition`, `effective_tier`, `step_pins`, `pre_approvals`, `enabled_by_user_id` change (owner columns may move — org merge repoints a moved org flow's publications; `ON DELETE SET NULL` of the delegator is allowed through by comparing `NEW.enabled_by_user_id IS NOT DISTINCT FROM OLD.enabled_by_user_id OR NEW.enabled_by_user_id IS NULL`).
  3. **`flow_runs`**: `id uuid pk`, `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, `flow_id uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE`, `flow_version_id uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE`, `definition_version integer NOT NULL`, `trigger_kind text NOT NULL`, `triggered_via text NOT NULL`, `trigger_payload jsonb`, `inputs jsonb`, `status text NOT NULL DEFAULT 'queued'`, `pre_approvals_honored boolean NOT NULL`, `current_step_id text`, `current_item_index integer`, `resume_seq integer NOT NULL DEFAULT 0`, `lease_token uuid`, `lease_expires_at timestamptz`, `wake_at timestamptz`, `dedupe_key text`, `chain_depth smallint NOT NULL DEFAULT 0`, `caused_by_run_id uuid` (plain uuid, no FK: the causing run may sit in another org's ledger after a merge), `triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`, `ai_session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL`, `active_ms bigint NOT NULL DEFAULT 0`, `last_heartbeat_at timestamptz`, `cancel_requested_at timestamptz`, `bodies_pruned_at timestamptz`, `error_code text`, `error text`, `started_at`, `finished_at timestamptz`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`. `trigger_payload` / `inputs` are nullable only so retention can prune them; the service always writes an object. CHECKs: status ∈ the eight; `trigger_kind IN ('manual','schedule','event','webhook','tool')`; `triggered_via` ∈ the six; `chain_depth BETWEEN 0 AND 3`; `(status IN ('completed','failed','cancelled','expired')) = (finished_at IS NOT NULL)`; `(status = 'awaiting_approval') <= (current_step_id IS NOT NULL)`; `(status = 'waiting') = (wake_at IS NOT NULL)`; `(bodies_pruned_at IS NULL) OR (finished_at IS NOT NULL)`; `char_length(error) <= 2000`. BEFORE UPDATE trigger `flow_runs_immutable_guard`: `org_id`, `flow_id`, `flow_version_id`, `trigger_kind`, `dedupe_key`, `pre_approvals_honored` never change (the `ai_agent_runs` precedent — runs are history that stays with their org). Indexes: `UNIQUE (id, org_id)` (composite-FK target), `flow_runs_dedupe_uq UNIQUE (flow_id, org_id, dedupe_key) WHERE dedupe_key IS NOT NULL`, `(flow_id, created_at DESC)`, `(org_id, created_at DESC)`, `flow_runs_active_idx (status, updated_at) WHERE status IN ('queued','running','waiting','awaiting_approval')`, `(finished_at) WHERE bodies_pruned_at IS NULL AND finished_at IS NOT NULL` (retention).
  4. **`flow_run_steps`**: `id uuid pk`, `run_id uuid NOT NULL`, `org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, `FOREIGN KEY (run_id, org_id) REFERENCES flow_runs(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`, `step_id text NOT NULL`, `item_index integer`, `attempt smallint NOT NULL DEFAULT 1`, `tool text NOT NULL`, `tool_source text NOT NULL`, `tier smallint NOT NULL`, `status text NOT NULL`, `approval_mode text NOT NULL DEFAULT 'none'`, `rendered_input jsonb`, `output jsonb`, `output_truncated boolean NOT NULL DEFAULT false`, `error_code text`, `error text`, `action_intent_id uuid` (no FK: `action_intents.requesting_flow_run_id` is the FK'd edge; a back-FK would make the cascade graph cyclic), `approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL`, `started_at timestamptz NOT NULL DEFAULT now()`, `finished_at timestamptz`, `duration_ms integer`. CHECKs for status, `tool_source IN ('core','tenant','builtin')`, `tier BETWEEN 1 AND 3`, `approval_mode IN ('none','intent','pre_approved')`, `char_length(error) <= 2000`. `flow_run_steps_attempt_uq UNIQUE (run_id, step_id, COALESCE(item_index, -1), attempt)` (unique index — the idempotency key), `(run_id, started_at)`.
  5. **RLS**: `flow_versions` ENABLE + FORCE, `flow_versions_isolation` FOR ALL (the `flows_isolation` predicate verbatim) + `flow_versions_partner_wide_select` FOR SELECT `(org_id IS NULL AND partner_id = public.breeze_current_partner_id())`. `flow_runs` and `flow_run_steps` ENABLE + FORCE with the four `breeze_org_isolation_{select,insert,update,delete}` policies on `breeze_has_org_access(org_id)` (the `action_intents` 2026-07-18 shape). `GRANT SELECT, INSERT, UPDATE, DELETE` on all three to `breeze_app`.
  6. **`action_intents`**: `ADD COLUMN IF NOT EXISTS requesting_flow_run_id uuid`; guarded `action_intents_requesting_flow_run_fk FOREIGN KEY (requesting_flow_run_id, org_id) REFERENCES flow_runs(id, org_id) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE`; drop/re-add `action_intents_one_actor_chk` as `num_nonnulls(requested_by_user_id, requesting_api_key_id, requesting_agent_run_id, requesting_flow_run_id) = 1`; `action_intents_source_chk` += `'flow'`; `action_intents_origin_principal_kind_chk` += `'flow'` (the newest definition is `2026-09-05-a-agent-originated-intents.sql:90-95` — `'user_session','client_user','api_key','oauth_grant','agent','ai_agent','helper','system','unknown'` — then append `'flow'`); new `action_intents_flow_origin_chk ((origin_principal_kind = 'flow') = (requesting_flow_run_id IS NOT NULL))` and `action_intents_flow_source_chk ((source = 'flow') = (origin_principal_kind = 'flow'))`; `CREATE OR REPLACE FUNCTION action_intents_block_content_update()` copied from the newest definition (`2026-10-16-193700-action-intents-external-tool.sql`) plus `requesting_flow_run_id` in the immutable set; partial index `(requesting_flow_run_id) WHERE requesting_flow_run_id IS NOT NULL`.
- [ ] **Step 3: Drizzle** in `flowRuns.ts` (toolSources style; composite FK and CHECKs documented in comments, enforced in SQL), the two `flows` columns, the `actionIntents` column and widened unions; export from `index.ts`.
- [ ] **Step 4: Run** the schema test → PASS; `npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` → PASS; on the wt-stack `pnpm db:migrate` twice (idempotency) then `pnpm db:check-drift` → clean; `\d+ flow_runs` shows `flow_runs_dedupe_uq` and the DEFERRABLE FKs.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): flow_versions, flow_runs, flow_run_steps tables and flow-origin action intents (#5219)"`

### Task A3: Cascade, export, org-merge, RLS-coverage registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `orgMergeCustomExecutors.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/services/orgMergeCustomExecutors.test.ts` (extend), `apps/api/src/db/schema/flowRuns.deviceFree.contract.test.ts`

- [ ] **Step 1: Failing unit tests**
  - `orgMergeCustomExecutors.test.ts`: `resolveFlows` on a loser **enabled** flow whose step tool it rewrites ⇒ the flow ends `status = 'paused'`, `paused_reason = 'org_merged'` (its publication still names the old qualified tool, so it must be re-enabled); a loser enabled flow with no rewrite stays `enabled`; every loser-org run in `queued|running|waiting|awaiting_approval` ends `cancelled` with `error_code = 'cancelled'`, `error = 'org_merged'` (its pending intents stay with the loser and die with it — a later approval hits the claim's `run_cancelled`); `flow_versions` of a moved org flow repoint with it.
  - `flowRuns.deviceFree.contract.test.ts`: none of `flow_versions`, `flow_runs`, `flow_run_steps` has a `device_id`, `site_id` or `ticket_id` column in the Drizzle schema (a later add must also join the device/ticket lists; the failure message names `routes/devices/core.ts` and `services/ticketOrgMoveLockOrder.ts`).
  Run → FAIL.
- [ ] **Step 2: Red the contract suites** — migration applied, no registry edit: run `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry` integration files and the unit `src/services/orgMerge.test.ts` (full file); record the failures for the PR body.
- [ ] **Step 3: Register**
  - `tenantCascade.ts`: `'flow_run_steps', 'flow_runs', 'flow_versions'` immediately before `'flows'` (L684), then let the FK-derived ordering (`topologicalCascadeOrder`, ~L1469, built from `pg_constraint`) confirm `action_intents` (RESTRICT on `flow_runs`) is deleted earlier; if it is not, move entries until it passes and say which in the PR.
  - `tenantExportPolicyRegistry.ts` (alphabetical): `flow_versions` — included all except `definition`, `step_pins`, `pre_approvals` (`excludedOpen`); `flow_runs` — included all except `trigger_payload`, `inputs` (`excludedOpen`); `flow_run_steps` — included all except `rendered_input`, `output` (`excludedOpen`); `flows` += `enabled_publication_seq`, `schedule_last_occurrence_key` (included); `flow_runs` `lease_token` → `excludedSensitive` (an execution capability, not tenant data); `action_intents` += `requesting_flow_run_id` (included).
  - `orgMergeRegistry.ts`: `flow_versions: { kind: 'repoint', note: 'publications follow their flow; partner-wide rows (org_id NULL) untouched' }`, `flow_runs: { kind: 'leave-for-erasure', note: 'org_id is trigger-immutable (flow_runs_immutable_guard); run history stays with the source org like ai_agent_runs, and keeps the action_intents (requesting_flow_run_id, org_id) FK consistent; active loser runs are cancelled in the flows resolve phase' }`, `flow_run_steps: { kind: 'leave-for-erasure', note: 'children of flow_runs (composite FK), erased with them' }`; extend the `flows` custom note with the `org_merged` pause and run cancellation. Implement both in `resolveFlows` (`orgMergeCustomExecutors.ts` ~L1912; the pause in the statement that rewrites `definition`).
  - `rls-coverage.integration.test.ts`: `'flow_versions'` in `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, comment citing the migration and `flowRunsPartnerRls.integration.test.ts`; a comment beside the `flows` entry noting `flow_runs`/`flow_run_steps` are shape 1 (auto-discovered, Open Decision 1).
- [ ] **Step 4: Run** the unit files + `src/services/tenantCascade.test.ts` + `src/services/orgMerge.test.ts` → PASS; the five integration suites + `orgMergeCustomExecutors.integration.test.ts` + `orgLifecycleFoundations.integration.test.ts` (merge contract: the DEFERRABLE FKs) → PASS, each > 0 tests.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): register flow versions and runs in cascade, export, org merge, RLS coverage (#5219)"`

### Task A4: Flow principal and the automation-principal sweep

**Files:**
- Modify: `apps/api/src/middleware/auth.ts`; every non-test file that compares `principal.kind` to `'ai_agent'` or calls `isAiAgentPrincipal` (~35 at authoring — the list is produced in Step 1, not assumed)
- Create: `apps/api/src/services/flows/flowAuthContext.ts`, `flowAuthContext.test.ts`, `apps/api/src/middleware/automationPrincipal.contract.test.ts`

**Interfaces (Produces):**
```ts
// middleware/auth.ts
export type PrincipalKind = … | { kind: 'flow'; flowId: string; runId: string };
export function isFlowPrincipal(auth: Pick<AuthContext, 'principal'>): boolean;
export function isAutomationPrincipal(auth: Pick<AuthContext, 'principal'>): boolean;   // ai_agent || flow
// services/flows/flowAuthContext.ts
export interface FlowRunRef { id: string; orgId: string; flowId: string }
export interface FlowIdentity { id: string; orgId: string | null; partnerId: string; status: FlowStatus }
export class FlowRunOwnershipError extends Error {}
export function assertFlowRunOwnership(flow: FlowIdentity, run: FlowRunRef, org: { id: string; partnerId: string }): void;
//   org flow ⇒ run.orgId === flow.orgId; partner flow ⇒ org.partnerId === flow.partnerId; run.flowId === flow.id
export function buildFlowAuthContext(flow: FlowIdentity, run: FlowRunRef, org: { id: string; partnerId: string }): AuthContext;
//   principal { kind:'flow', flowId, runId }; scope 'organization'; orgId = run.orgId; accessibleOrgIds [orgId];
//   user = synthetic attribution identity (id = flow.id, never a users row), token null, no role (agent precedent agentAuthContext.ts:86)
export function flowDbAccessContext(orgId: string, partnerId: string): DbAccessContext;   // = agentDbAccessContext shape, userId null
```

- [ ] **Step 1: Inventory + failing contract test.** `rg -n "kind === 'ai_agent'|kind !== 'ai_agent'|isAiAgentPrincipal\(" apps/api/src --glob '!*.test.ts'` ⇒ write the result into `automationPrincipal.contract.test.ts` as `REVIEWED_AI_AGENT_SITES: Record<'file:snippet', 'automation' | 'agent_only'>` — every site classified: `automation` = the rule means "no human present / no RBAC token / no interactive approval surface / no secret reveal" (must use `isAutomationPrincipal`); `agent_only` = the rule needs `agentId`/agent run state (e.g. ticket actor attribution `aiToolsTicketing.ts:93`, workspace run resources `workspaceTools.ts:56`) — stays agent-specific **and** must refuse a flow principal explicitly (`isFlowPrincipal(auth) ⇒ deny`) unless the site is unreachable from a flow (not in `listFlowEligibleCoreTools()`), which the entry's comment states. Never substitute `runId` for `agentId`. The test greps the same pattern and fails on any unclassified site, on any `automation` site still using the raw comparison, and on any reachable `agent_only` site without a flow refusal. `flowAuthContext.test.ts`: ownership matrix (org flow / other org ⇒ throws; partner flow / org of another partner ⇒ throws); built context has `principal.kind === 'flow'`, no token, `isAutomationPrincipal` true, `isInteractiveUserSession` false; `checkToolPermission(anyTool, {}, flowAuth)` denies (no RBAC for a machine principal — the runner never calls it). Run → FAIL.
- [ ] **Step 2: Implement** the kind, helpers, `flowAuthContext.ts`, and convert every `automation` site. Typecheck (12 GB, `exit=`) — exhaustive switches on `principal.kind` surface as errors; each gets an explicit `flow` arm.
- [ ] **Step 3: Run** the two tests + `src/services/aiGuardrails.agentPrincipal.contract.test.ts` + `src/middleware/auth.test.ts` + the test files of every converted module (batches) → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): flow principal kind and isAutomationPrincipal sweep (#5219)"`

### Task A5: Flow-origin action intents — create, fan-out, claim, release, wake

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts`, `apps/api/src/services/actionIntents/actorContext.ts`, `apps/api/src/services/actionIntents/revalidateRelease.ts`, `apps/api/src/services/approvals/decideApprovalRequest.ts`, `apps/api/src/services/actionIntents/intentApprovers.ts`, `apps/api/src/jobs/intentReleaseWorker.ts`, `apps/api/src/services/aiOperator/taskOutbox.ts`, `apps/api/src/services/eventBus.ts` (`BreezeEvent.metadata` += `flowRunId?`, `flowChainDepth?`, stamped from the flow execution context)
- Create: `apps/api/src/services/flows/intentClaim.ts`, `intentClaim.test.ts`, `apps/api/src/services/flows/releaseAuthority.ts`, `releaseAuthority.test.ts`, `apps/api/src/services/flows/wake.ts`, `wake.test.ts`, `apps/api/src/services/flows/flowExecutionContext.ts`, `flowExecutionContext.test.ts`
- Test (extend): `intentService.test.ts`, `decideApprovalRequest.flow.test.ts` (create), `revalidateRelease.test.ts`, `intentReleaseWorker.test.ts`, `eventBus.test.ts`

**Interfaces:**
- Consumes: `flowRuns`, `flowRunSteps`, `flowVersions` (A2); `buildFlowAuthContext` (A4).
- Produces:
```ts
// intentService.ts (additive)
CreateActionIntentInput.source: 'chat' | 'mcp_api' | 'ai_agent' | 'flow';
CreateActionIntentInput.flowRun?: { runId: string; stepRowId: string; delegatorUserId: string | null; flowName: string; stepId: string };
//   required iff source === 'flow' (else 'flow_source_mismatch'); auth must be a flow principal whose runId matches.
//   Writes requesting_flow_run_id, origin_principal_kind 'flow', requested_by_user_id NULL.
//   requestingClientLabel = `Flow ${flowName}`; actionLabel = `Step ${stepId}: ${tool}` (spec §6.5 card copy).
//   Expiry: computeExpiresAt('flow', scope) = FLOW_APPROVAL_TTL_HOURS (default 24 h) for both scopes.
//   Fan-out: the ai_agent branch of runHumanFanout (intentService.ts:963-978), plus NEW logic: a four_eyes flow intent's pool
//   excludes delegatorUserId. Like the agent branch there is no sole-operator fallback, so a four-eyes step whose only eligible
//   approver is the delegator gets 'no_eligible_approvers' (existing cancel path) and the run fails 'no_eligible_approvers'.
// flows/intentClaim.ts
export type FlowClaimResult =
  | { claimed: true }
  | { claimed: false; reason: 'lost_race' }   // intent no longer 'approved' — another dispatcher won or it was already handled: no-op, no side effects
  | { claimed: false; reason: 'run_not_waiting' | 'flow_not_enabled' | 'publication_moved' | 'tool_revision_changed' | 'approval_scope_changed' | 'delegator_inactive' | 'run_cancelled' };
export async function claimFlowLinkedIntentForDispatch(intentId: string): Promise<FlowClaimResult>;
//   One system tx: SELECT the intent FOR UPDATE; status ≠ 'approved' ⇒ lost_race (return before touching anything else).
//   Then SELECT flow_runs … FOR UPDATE (by requesting_flow_run_id), the flows row, the run's flow_versions row, the delegator.
//   Claimed iff run.status = 'awaiting_approval' AND the step row's action_intent_id = intentId AND cancel_requested_at IS NULL
//   AND flows.status = 'enabled' AND the flow's live publication (flow_id, enabled_publication_seq) is run.flow_version_id
//   AND the publication's delegator is an active user AND (tenant step) live descriptor revision = pinned revision
//   AND the live approval scope (checkGuardrails on the intent's input) equals the pinned one;
//   then CAS intent approved → executing. Otherwise CAS intent approved → cancelled (error_code 'flow_drift'),
//   step → failed, run → failed 'drift' / 'delegator_inactive' (pausing the flow), or 'cancelled', and wake.
// flows/releaseAuthority.ts
export async function checkFlowReleaseAuthority(intent: ActionIntent): Promise<{ ok: true; auth: AuthContext } | { ok: false; code: string }>;
//   rebuilds buildFlowAuthContext for the run; refuses when assertFlowRunOwnership fails.
// flows/wake.ts
export function scheduleFlowRunWake(runId: string): void;   // runAfterDbContextCommit('flow-run-wake', () => enqueueFlowRunSlice(runId))
// flows/flowExecutionContext.ts (AsyncLocalStorage, Decision 14)
export interface FlowExecutionFrame { runId: string; chainDepth: number }
export function withFlowExecutionContext<T>(frame: FlowExecutionFrame, fn: () => Promise<T>): Promise<T>;
export function currentFlowExecutionFrame(): FlowExecutionFrame | undefined;
//   eventBus.publishEvent: when a frame is present, metadata.flowRunId = frame.runId, metadata.flowChainDepth = frame.chainDepth
//   (overriding any caller-supplied values — callers cannot forge or clear ancestry from inside a flow).
```
Release-worker changes: in `releaseApprovedIntent` (~L1025), `source === 'flow'` takes `claimFlowLinkedIntentForDispatch` instead of the plain `approved → executing` CAS (beside the task-linked branch, ~L1093); `lost_race` returns without writing; `buildAuthContextForIntent` (`actorContext.ts:105`) maps origin `flow` → `checkFlowReleaseAuthority`; `revalidateApprovedIntentForRelease` branch (e) (`revalidateRelease.ts` ~L500) gains `if (intent.requestingFlowRunId)` → structural flow authority (never `checkToolPermission`, which denies machine principals); the tenant-tool release (`executeTenantToolDetailed`, ~L1413-1415) passes `actor: { kind: 'flow', id: runId }` instead of the chat/user attribution; the tool call runs inside `withFlowExecutionContext({ runId, chainDepth })` (Decision 14); `notifyRequesterOfOutcome` (~L1862) is a no-op for flow intents (the run timeline is the outcome surface). Outcome mapping the runner applies on wake: intent `completed` ⇒ step completed with `result`; `failed` with `error_code = 'execution_error'` and `result.executed === true`, or `error_code = 'execution_lost'` ⇒ step `unknown_outcome`, run failed `unknown_outcome` (ignores `onFailure`); any other `failed` ⇒ step failed, `onFailure` applies. `publishIntentTerminalOutbox` (`taskOutbox.ts:152`) — the single writer every terminal transition already calls (release complete/fail, deny, expiry reaper, cancel) — calls `scheduleFlowRunWake(intent.requestingFlowRunId)` when set. Decide path: the supervised check for flow intents uses `isAgentIntentDecideAuthorized` semantics (`intentApprovers.ts:506`) — the pool, not "must be the requester".

- [ ] **Step 1: Failing tests**
  - `intentService.test.ts`: `source 'flow' without flowRun ⇒ flow_source_mismatch`; `flow intent writes requesting_flow_run_id and origin 'flow'`; `four-eyes flow intent never routes to the delegator`; `four-eyes flow intent whose only approver is the delegator is cancelled no_eligible_approvers`; `supervised flow intent fans out to the eligible pool including the delegator`; `flow intent expires after FLOW_APPROVAL_TTL_HOURS`; labels equal `Flow Disk cleanup` / `Step cleanup: run_script`.
  - `intentClaim.test.ts` (DB mocked at the module boundary): `claim succeeds on an untouched run`; `claim refuses when the flow moved to a new version` (new publication); `claim refuses when the flow is disabled`; `claim refuses on tenant revision change`; `claim refuses when supervised became four_eyes`; `claim refuses and pauses on an inactive delegator`; `claim refuses a cancelled run and marks it cancelled`; `duplicate delivery after a won claim is lost_race and cancels nothing`; every other refusal cancels the intent and schedules a wake.
  - `decideApprovalRequest.flow.test.ts` (new; copy the harness of `decideApprovalRequest.diagnosticAccess.test.ts`): a pool member approves a supervised flow intent (no `not_requester`); the delegator approving a four-eyes flow intent ⇒ refused unless sole-operator rules allow.
  - `revalidateRelease.test.ts`: a flow intent takes the flow-authority branch and never calls `checkToolPermission`.
  - `intentReleaseWorker.test.ts`: a flow intent goes through the flow claim, executes with the flow principal auth (tenant release with `actor.kind === 'flow'`), and `notifyRequesterOfOutcome` is not called; a terminal transition calls `scheduleFlowRunWake` exactly once.
  - `wake.test.ts`: the enqueue runs only after commit (rollback ⇒ none).
  - `flowExecutionContext.test.ts` + `eventBus.test.ts`: an event published inside `withFlowExecutionContext` carries `flowRunId`/`flowChainDepth`; a caller-supplied `flowChainDepth: 0` inside a frame of depth 2 is overwritten; outside a frame nothing is added.
  Run → FAIL.
- [ ] **Step 2: Implement.** Do not touch the chat inline-release path (`aiAgentSdk.ts:1838`) — flow intents never have a waiting chat turn.
- [ ] **Step 3: Run** the files above + `src/jobs/intentExpiryReaper.test.ts` + `src/services/aiOperator/dispatchClaim.test.ts` (unchanged behaviour) → PASS; tsc `exit=0` (the widened `source` union surfaces every exhaustive switch).
- [ ] **Step 4: Commit** — `git commit -m "feat(api): flow-origin action intents with drift-checked release and run wake (#5219)"`

### Task A6: Enable / disable — versions, rule 4 eligibility, rule 7

**Files:**
- Create: `apps/api/src/services/flows/versions.ts`, `versions.test.ts`, `apps/api/src/services/flows/preApproval.ts`, `preApproval.test.ts`
- Modify: `apps/api/src/services/flowValidator.ts` (+ test), `apps/api/src/services/flows/service.ts` (+ test), `apps/api/src/services/flows/repository.ts` (slug tests live in `service.test.ts`)

**Interfaces:**
- Consumes: `validateFlowDocument`, `loadFlowCatalog`, `lockFlowSlugsForPartner`, `assertFlowSlugAvailable`, `ownerForFlowRow` (W03); `checkToolPermissionForResolvedUser` (`aiGuardrails.ts:2947`), `getUserPermissions`, `tenantToolPermissionRequirement`; `buildRunScriptSnapshot` / `runScriptDigestMaterial` (`actionIntents/runScriptSnapshot.ts:211,337`).
- Produces:
```ts
// flowValidator.ts (new exports)
export interface FlowStepPin { stepId: string; tool: string; source: 'core' | 'tenant' | 'builtin'; tier: 1 | 2 | 3;
  approvalScope: 'supervised' | 'four_eyes' | null; tenantToolId?: string; tenantRevision?: string }
export async function stepPinsFor(doc: FlowDocumentV1, ctx: FlowValidationContext): Promise<FlowStepPin[]>;   // from the same catalog pass as validation
export async function revalidateRenderedStep(pin: FlowStepPin, rendered: Record<string, unknown>, ctx: { owner: ToolOwnerRef; runOrgId: string }):
  Promise<{ ok: true; tier: 1 | 2 | 3; approvalScope: 'supervised' | 'four_eyes' | null } | { ok: false; code: 'input_invalid' | 'tool_unavailable' | 'tool_blocked' | 'drift' | 'reference_not_owned'; message: string }>;
//   unmasked schema validation (Zod / compileTenantInputSchema); live catalog entry must exist (else tool_unavailable);
//   tenant revision must equal the pin (else drift); live tier recomputed with checkGuardrails on the rendered input —
//   tier 4 / blocked ⇒ tool_blocked, tier > pinned or approvalScope ≠ pinned ⇒ drift; ownership of every rendered FLOW_OWNED_REFERENCE_FIELDS and
//   deviceArgs id: scripts via findOwnedScriptIds(owner), groups and devices via findOwnedDeviceGroupIds / findOwnedDeviceIds(runOrgId)
//   (all three in services/flows/ownedReferences.ts:34/47/60)
//   (partner-wide flows included — the run has one org). Messages never distinguish foreign from missing.
// preApproval.ts
export interface FlowPreApprovalBinding { stepId: string; lane: 'act_asset'; assetKind: 'script'; scriptId: string; contentDigest: string }
export type PreApprovalEligibility = { eligible: true } | { eligible: false; reason: 'not_tier3' | 'tool_not_supported' | 'script_not_literal' | 'group_target' | 'variable_dependent' | 'four_eyes' | 'tenant_tool' };
export function preApprovalEligibility(step: FlowDocumentV1['steps'][number], pin: FlowStepPin): PreApprovalEligibility;   // static checks
export async function scriptPreApprovalMaterial(scriptId: string): Promise<{ contentDigest: string; variableDependent: boolean } | null>;
//   contentDigest = sha256 hex of runScriptDigestMaterial(snapshot) with deviceOrgIds and variableReferences omitted (content,
//   language, timeoutSeconds, runAs, parameterDefinitions), via buildRunScriptSnapshot with a placeholder device set;
//   variableDependent = the snapshot has any variableReferences (enable refuses: reason 'variable_dependent', Decision 3).
// versions.ts
export type EnableFlowResult =
  | { ok: true; flow: FlowDetailDto; publication: { id: string; publicationSeq: number; definitionVersion: number } }
  | { ok: false; error: 'flow_not_found' | 'version_conflict' | 'already_enabled' | 'invalid' | 'permission_missing' | 'pre_approval_not_eligible' | 'event_dispatch_not_durable' | 'foreach_concurrency_not_available' | 'slug_unavailable' | 'interactive_session_required' | 'delegation_scope_restricted'; validation?: FlowValidationResult; missing?: Array<{ stepId: string; permission: string }>; stepId?: string };
export async function enableFlow(auth: AuthContext, flowId: string, req: FlowEnableRequest): Promise<EnableFlowResult>;
export async function disableFlow(auth: AuthContext, flowId: string): Promise<{ ok: true; cancelledRuns: number } | { ok: false; error: 'flow_not_found' | 'not_enabled' }>;
export async function pauseFlow(flowId: string, reason: 'drift' | 'binding_drift' | 'delegator_inactive' | 'org_merged' | 'event_dispatch_not_durable'): Promise<void>;   // system-set; enabled_publication_seq kept so re-enable shows what was live
// repository.ts (W03, changed)
export async function takenFlowSlugs(owner: ToolOwnerRef, base: string, opts?: { excludeFlowId?: string }): Promise<Set<string>>;
// service.ts (W03, changed)
export async function assertFlowSlugAvailable(owner: ToolOwnerRef, slug: string, opts?: { excludeFlowId?: string }): Promise<boolean>;
//   today the flow being enabled counts as taking its own slug (repository.ts:31) — enable passes excludeFlowId.
```
`enableFlow` order (one transaction in the caller's context except the system reads the W03 helpers already make): interactive `user_session` only (`interactive_session_required`); row visible + writable, `expectedVersion === definition_version` (else `version_conflict`), status ∈ `draft|disabled|paused`; partner-wide ⇒ `canManagePartnerWidePolicies`; delegation ceiling (Decision 13): `perms = getUserPermissions(auth.user.id, { partnerId: owner.partnerId, orgId: owner.orgId ?? undefined, scope: owner.orgId ? 'organization' : 'partner' })` (`permissions.ts:195`; the context argument is required) has no site allowlist, and for a partner-wide flow `auth.partnerOrgAccess === 'all'` (`middleware/auth.ts:186`; `UserPermissions.orgAccess` is the same fact) — else `delegation_scope_restricted`; `validateFlowDocument` zero errors (else `invalid`); event trigger ⇒ Open Decision 10 check; any `forEach.concurrency > 1` ⇒ refused; rule 7: with the same `perms`, every core step `checkToolPermissionForResolvedUser(tool, literalInput, perms)` and every tenant step `tenantToolPermissionRequirement(tier)`, collecting all misses (`permission_missing` + `missing[]`); each `preApprovedStepIds` entry eligible statically and by `scriptPreApprovalMaterial` (null or `variableDependent` ⇒ refused) else `pre_approval_not_eligible` + `stepId` + `reason`; `lockFlowSlugsForPartner` + `assertFlowSlugAvailable(owner, slug, { excludeFlowId: flowId })` (the shadow rule may have changed since save); insert a new `flow_versions` publication with `publication_seq = COALESCE(max, 0) + 1` for the flow (always a new row — Decision 2), `step_pins` from `stepPinsFor`, `pre_approvals` bindings, `enabled_by_user_id = auth.user.id`; set `status='enabled'`, `enabled_publication_seq`, `enabled_by_user_id`, `enabled_at`, `paused_reason = NULL`, `schedule_last_occurrence_key` = the current occurrence key (so enabling never fires a past occurrence). Audit `flow.enable` with `{ publicationSeq, definitionVersion, preApprovedStepIds, effectiveTier }`. `disableFlow`: status → `disabled`, `enabled_publication_seq = NULL`; queued/waiting runs → `cancelled`; `awaiting_approval` runs → their intents cancelled through the existing cancel path (which wakes them → `cancelled`); running runs get `cancel_requested_at`. Audit `flow.disable`. `getFlow` (W03) additionally returns `preApprovalEligibility: Record<stepId, PreApprovalEligibility>` for every Tier-3 step (static checks + `scriptPreApprovalMaterial`, computed live) and the live publication's bound step ids, so the enable dialog never guesses. `service.ts`: `saveDraftFlow` accepts `status ∈ {draft, disabled, paused}` (refuses `enabled` with the existing `flow_not_draft`), keeps the status, bumps the version; validator widens the event warning to Open Decision 10's wording and code `event_dispatch_not_durable`.

- [ ] **Step 1: Failing tests**
  - `versions.test.ts`: `api key cannot enable`; `stale expectedVersion is version_conflict`; `event flow refused unless enforce and member` (three env cases: off / shadow / enforce-without-membership ⇒ refused; enforce+member ⇒ ok); `forEach concurrency 2 refused`; `missing permissions are all listed`; `ineligible pre-approval names the step`; `slug shadowed since save is slug_unavailable`; `the flow's own slug does not block its enable`; `site-limited user is delegation_scope_restricted`; `partner user with selected-org access cannot enable a partner-wide flow`; `enable writes a publication with pins and bindings and sets the occurrence key`; `re-enable of unchanged content writes publication_seq 2`; `disable cancels queued and parked runs and flags running ones`.
  - `preApproval.test.ts`: eligible `run_script { scriptId: <uuid>, deviceIds: ['{{trigger.device.id}}'] }` tier 3 supervised; `groupId` ⇒ `group_target`; templated `scriptId` ⇒ `script_not_literal`; four_eyes ⇒ `four_eyes`; tenant tool ⇒ `tenant_tool`; tier 2 ⇒ `not_tier3`; `scriptPreApprovalMaterial` digest changes when content changes and not when the device set changes; a script with a tenant-variable parameter binding is `variableDependent`.
  - `flowValidator.test.ts`: `revalidateRenderedStep` — `templated uuid rendered to "abc" is input_invalid`; `rendered device in another org is reference_not_owned`; `partner flow rendered device in the run org passes`; `tenant revision change is drift`; `tool removed from catalog is tool_unavailable`; `supervised step now four_eyes is drift`; `stepPinsFor carries approvalScope for core tier-3 steps`.
  - `service.test.ts`: `disabled flow can be edited and stays disabled`; `enabled flow edit is flow_not_draft`; `getFlow reports pre-approval eligibility per tier-3 step`.
  Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** the four files + `src/__tests__/partner-wide-write-coverage.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): enable/disable flows with published versions, rule 7 and act-asset pre-approval (#5219)"`

### Task A7: Step executor

**Files:**
- Create: `apps/api/src/services/flows/stepExecutor.ts`, `stepExecutor.test.ts`, `apps/api/src/services/flows/triggerScope.ts`, `triggerScope.test.ts`

**Interfaces:**
- Consumes: `renderTemplates`, `evaluateExpr`, `parseExpr`, `isTruthy`, `FLOW_BUILTIN_STEPS` (shared); `revalidateRenderedStep`, `FlowStepPin`, `FlowPreApprovalBinding`, `scriptPreApprovalMaterial` (A6), `withFlowExecutionContext` (A5); `executeTool` (`aiTools.ts:637`), `executeTenantToolDetailed` (`toolSources/execute.ts:74`, `actor: { kind: 'flow', id: runId }`, `surface` widened with `'flow'`), `loadTenantToolForExecution` (`resolver.ts:555`); `createActionIntent` (A5).
- Produces:
```ts
// triggerScope.ts
export interface FlowTriggerScope { kind: FlowTriggerKind; orgId: string; firedAt: string; event?: { id: string; type: string };
  payload?: Record<string, FlowValue>; device?: { id: string; hostname: string; siteId: string | null } }
export async function buildTriggerScope(input: { kind: FlowTriggerKind; orgId: string; event?: BreezeEvent }): Promise<FlowTriggerScope>;
//   device enrichment only when payload.deviceId is a uuid of a device in orgId (one query in the flow DB context); payload stored redacted with `redactPersistedToolInput` (`services/aiToolOutput.ts:264`).
// stepExecutor.ts
export type StepOutcome =
  | { kind: 'completed'; output: FlowValue; truncated: boolean }
  | { kind: 'skipped' }
  | { kind: 'failed'; code: FlowRunErrorCode; message: string; policy: boolean }   // policy=true ⇒ fail the run regardless of onFailure
  | { kind: 'park_approval'; intentId: string }
  | { kind: 'park_wait'; resumeAt: Date };
export interface StepExecutionInput { run: FlowRunRow; version: FlowVersionRow; step: FlowDocumentV1['steps'][number]; pin: FlowStepPin;
  itemIndex: number | null; item: FlowValue | undefined; scope: FlowScope; auth: AuthContext; deadline: number; stepRowId: string }
export async function executeFlowStep(i: StepExecutionInput): Promise<StepOutcome>;
```
Order inside `executeFlowStep`: `when` (false ⇒ `skipped`); render `input` (`render_failed` on `render_too_large`/parse error); built-ins — `set` returns its `values`, `wait` returns `park_wait` (now + minutes) the first time and `completed` with `{ waitedMinutes }` when the step row is re-entered after `resumeAt`; `revalidateRenderedStep` (failure ⇒ `failed`, `policy: true`); tier 3 ⇒ if `run.preApprovalsHonored` and a binding exists for `step.id`: rendered `deviceIds` length must be 1 (else `failed policy`), `scriptPreApprovalMaterial(scriptId)` returns the bound `contentDigest` and `variableDependent: false` (else `binding_drift`, `policy: true`; the runner pauses the flow), then `executeTool('run_script', rendered, auth, { context: { verifiedRunScript: … } })` — build the pin exactly as `actRevalidation.ts` `pinRunScript` (~L190) does; otherwise `createActionIntent(auth, { source: 'flow', flowRun: {…}, toolName, input: rendered, … })` ⇒ `park_approval`; tier 1/2 core ⇒ `executeTool(tool, rendered, auth)`; tenant ⇒ `executeTenantToolDetailed(descriptor, rendered, auth, { orgId: run.orgId, actor: { kind: 'flow', id: run.id }, surface: 'flow' })`. Tool results are parsed as JSON when possible (else `{ text }`), an `{ error }` result or `isError` ⇒ `failed` (`step_failed`, `policy: false`); output above `maxStoredOutputBytes` ⇒ stored as `{ truncated: true, preview: <first 8 KB> }`. Tier-1 transient failures (network errors, 5xx, 429 — no tool-result classifier exists on main, so add a local `isTransientFlowToolError(result | error)` in `stepExecutor.ts`, pinned by its own test table) retry 3× with 1 s / 4 s / 16 s backoff inside the call; tier ≥ 2 never retries. Every tool call runs inside `withFlowExecutionContext({ runId, chainDepth })` (Decision 14). Timeout (Decision 15): the call is raced against `deadline` (`timeoutSec`); `executeTool` cannot be aborted, so on timeout the executor returns immediately — tier 1 ⇒ `failed` `step_timeout` (retryable by the transient rule), tier ≥ 2 ⇒ `unknown_outcome` — and the runner's lease-conditional checkpoint guarantees the late result is never written.

- [ ] **Step 1: Failing tests** (`stepExecutor.test.ts`, executors mocked): `when false skips`; `set returns values`; `wait parks then completes`; `rendered input re-validated unmasked`; `templated device id outside the run org is refused` (policy failure, executor never called); `tier 3 without pre-approval creates a flow intent and parks`; `pre-approval ignored when not honoured`; `pre-approved run_script executes with a verifiedRunScript pin`; `pre-approved run_script with two rendered devices fails policy`; `content change is binding_drift`; `tenant step executes with actor kind flow`; `tier-1 transient error retries 3 times`; `tier-2 error never retries`; `tier-3 timeout is unknown_outcome`; `late result after timeout is not returned`; `variable-dependent script at run time is binding_drift`; `events published by a step carry the run's chain depth`; `oversized output is truncated`. `triggerScope.test.ts`: device enrichment only for a device in the run org; foreign `deviceId` leaves `device` absent; secrets in payload are redacted. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run → PASS. Step 4: Commit** — `git commit -m "feat(api): flow step executor with run-time revalidation, ownership checks and pre-approved script pins (#5219)"`

### Task A8: Runner worker, reconciler, retention

**Files:**
- Create: `apps/api/src/jobs/flowRunner.ts`, `flowRunner.test.ts`, `apps/api/src/services/flows/runLease.ts`, `runLease.test.ts`, `apps/api/src/jobs/flowRunReconciler.ts`, `flowRunReconciler.test.ts`, `apps/api/src/jobs/flowRunRetention.ts`, `flowRunRetention.test.ts`, `apps/api/src/services/flows/runAdmission.ts`, `runAdmission.test.ts`
- Modify: `apps/api/src/jobs/queueSchemas.ts`, `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts`, `apps/api/src/services/eventBus.ts` (`'flow.run.completed'`, `'flow.run.failed'` in `EventType` + `EVENT_TYPES`), `apps/api/src/config/env.ts`, `validate.ts` (+ tests), compose ×2, `.env.example` ×2

**Interfaces:**
- Consumes: A2 tables; A4 `buildFlowAuthContext`, `flowDbAccessContext`; A6 `pauseFlow`; A7 `executeFlowStep`, `buildTriggerScope`.
- Produces:
```ts
// flowRunner.ts
export const FLOW_RUNS_QUEUE = 'flow-runs';
export async function enqueueFlowRunSlice(runId: string): Promise<void>;
//   createInstrumentedQueue; jobId bullmqJobId('flow-run', runId, resumeSeq) read from the row; enqueueOrReplaceStale;
//   removeOnComplete {count:200}, removeOnFail {count:500}.
export async function processFlowRunJob(job: Job<{ runId: string }>): Promise<void>;
export function initializeFlowRunner(): Promise<void>; export function shutdownFlowRunner(): Promise<void>;
// runAdmission.ts
export async function claimRunSlot(run: { id: string; flowId: string; orgId: string }, owner: ToolOwnerRef): Promise<boolean>;
//   one tx: pg_advisory_xact_lock(hashtextextended('flow_run_slots:' || ownerKey, 0)); refuse when a 'running' run exists for
//   (flow_id, org_id) or the owner's running count ≥ flowMaxRunningPerOwner(); else CAS queued|waiting → running.
export async function assertActiveCapacity(owner: ToolOwnerRef): Promise<{ ok: true } | { ok: false; error: 'flow_queue_full' }>;   // queued+running+waiting+awaiting_approval < 1,000
// runLease.ts (Decision 15)
export async function acquireRunLease(runId: string, expect: FlowRunStatus[]): Promise<{ token: string } | null>;
//   CAS: status ∈ expect AND (lease_token IS NULL OR lease_expires_at < now()) ⇒ lease_token = gen_random_uuid(), lease_expires_at = now() + 6 min
export async function checkpoint(runId: string, token: string, patch: Partial<FlowRunRow>, stepPatch?: { id: string; values: Partial<FlowRunStepRow> }): Promise<boolean>;
//   one tx; every UPDATE is `WHERE id = $run AND lease_token = $token`; renews lease_expires_at; false ⇒ the slice lost its lease and stops without further writes
export async function releaseRunLease(runId: string, token: string): Promise<void>;
export async function assertFlowRunAdmission(owner: ToolOwnerRef, flowId: string): Promise<{ ok: true } | { ok: false; error: string }>;
//   W05 seam (budgets, monthly caps): returns { ok: true } in W04; called at every run creation.
// env.ts
export function flowMaxRunningPerOwner(): number;   // FLOW_MAX_RUNNING_PER_OWNER, default 20, 1..500
export function flowRunRetentionDays(): number;     // FLOW_RUN_RETENTION_DAYS, default 90, 7..3650
export function flowApprovalTtlHours(): number;     // FLOW_APPROVAL_TTL_HOURS, default 24, 1..168
```
`processFlowRunJob` (worker concurrency 10, `lockDuration 300_000`, `stalledInterval 60_000`, `maxStalledCount 2`; payload validated with `parseQueueJobData` from `services/bullmqValidation.ts:17`, schema in `jobs/queueSchemas.ts`):
1. `!flowsEnabled()` ⇒ run failed `flows_disabled`, return. Load run + publication + flow in a brief system read; terminal ⇒ return; `waiting` with `wake_at > now()` ⇒ return (early wake). `acquireRunLease` (null ⇒ another slice owns the run ⇒ return). Every later write goes through `checkpoint`; a `false` ends the slice silently.
2. Delegator check (every slice, including resumes — Decision 7): publication's `enabled_by_user_id` null, or that user not `active` ⇒ `pauseFlow(flowId, 'delegator_inactive')`, run failed `delegator_inactive`.
3. Flow not `enabled` or the live publication (`flow_id`, `enabled_publication_seq`) is not `run.flow_version_id` ⇒ run `cancelled` (`flow_disabled`) when disabled, `failed` `drift` otherwise.
4. Resuming from `awaiting_approval`: read the step's intent — `completed` ⇒ step completed with `intent.result`; `rejected` ⇒ run failed `rejected`; `expired` ⇒ run `expired`; `cancelled` ⇒ run `cancelled` if `cancel_requested_at` else failed `drift` (the claim already wrote the run in that case — no-op); `failed` ⇒ the Task A5 outcome mapping (`unknown_outcome` for `execution_error` + `executed` or `execution_lost`, else step failed + `onFailure`). Not terminal yet (`approved`, `executing`, `pending_approval`) ⇒ release the lease and return (spurious wake).
5. `claimRunSlot` false ⇒ `job.moveToDelayed(Date.now() + slotRetryDelayMs, token)` + `throw new DelayedError()` (`accountingJobDelay.ts:43`).
6. Stalled-redelivery check: a step row of this run in `running` ⇒ tier 1 ⇒ mark it `failed` (`worker_lost`) and re-execute as `attempt + 1`; tier ≥ 2 ⇒ `unknown_outcome`, run failed `unknown_outcome`, publish `flow.run.failed`.
7. Loop from the cursor: check `cancel_requested_at` before every step and every for-each item; insert the step row `running` (unique attempt key — a conflict means another worker owns it ⇒ return); `executeFlowStep` under `withDbAccessContext(flowDbAccessContext(…))` **only for DB reads** — external I/O runs outside any transaction (spec §6.5); then one transaction writes the outcome, `current_step_id`/`current_item_index`, `active_ms += elapsed`, `last_heartbeat_at`. `park_approval` ⇒ step + run `awaiting_approval`, `resume_seq + 1`, return. `park_wait` ⇒ run `waiting` with `wake_at = resumeAt`, `resume_seq + 1`, enqueue the next slice with `delay`, return. For-each: render `items` via `evaluateExpr`; not an array ⇒ `failed`; length > `forEach.maxItems` ⇒ `too_many_items`; items processed sequentially with `item` in scope; step status is `failed` if any item failed under `stop`. `active_ms > maxActiveMs` ⇒ `run_timeout`. `binding_drift` ⇒ `pauseFlow(flowId, 'binding_drift')`.
8. End ⇒ `completed` (or `failed` when a `continue` step failed — spec §6.5 step 7), `finished_at`, publish `flow.run.completed|failed` with payload `{ flowId, runId, chainDepth, status }` via `publishEvent(type, run.orgId, payload, 'flow-runner')` after commit.

Reconciler (`flowRunReconciler.ts`, repeatable `every: 60_000`, jobId `flow-run-reconcile`, global placement): (a) `queued` runs with `updated_at < now() - 2 min` ⇒ `enqueueFlowRunSlice`; (b) `awaiting_approval` runs whose step intent is terminal ⇒ enqueue; (c) `running` runs whose `lease_expires_at < now()` ⇒ enqueue (the new slice acquires the expired lease; the stalled-row rule in step 6 decides retry vs `unknown_outcome`, and the old slice's late checkpoint fails on the token); (d) `waiting` runs with `wake_at < now() - 2 min` ⇒ enqueue; (e) when the deployment no longer delivers events durably (Decision 10), `pauseFlow(id, 'event_dispatch_not_durable')` for every enabled event flow (also run once at worker init). Each pass ≤ 500 rows per clause, `FOR UPDATE SKIP LOCKED`, system context. Retention (`flowRunRetention.ts`, `upsertJobScheduler` daily via a new kebab-case key `jobSchedule('flow-run-retention')` registered in `jobs/scheduleRegistry.ts`; `jobs/aiToolOutputRetention.ts` is the pruning precedent, not the scheduling one): for terminal runs with `finished_at < now() - flowRunRetentionDays()` and `bodies_pruned_at IS NULL`, in batches of 1,000, set `trigger_payload`, `inputs` and every step's `rendered_input`, `output` to NULL and stamp `bodies_pruned_at` (rows are never deleted — Decision 9).

- [ ] **Step 1: Failing tests** (`flowRunner.test.ts`, BullMQ + DB mocked per `breeze-testing`; executor mocked): `three tier-1 steps complete in order`; `skipped step leaves status skipped and output null`; `tier-3 step parks and job returns`; `approve wake copies intent result and continues`; `deny fails the run rejected`; `expired intent expires the run`; `stalled tier-3 step becomes unknown_outcome`; `stalled tier-1 step retries`; `onFailure continue proceeds and run ends failed`; `onFailure stop fails the run`; `policy failure ignores onFailure continue`; `cancel between for-each items`; `wait re-enqueues with delay and excludes waited time from active_ms`; `run_timeout after 3600 s active`; `flag off fails the run flows_disabled without executing`; `inactive delegator pauses the flow`; `disabled flow cancels a queued run`; `version moved fails drift`; `no slot delays without consuming an attempt`; `binding_drift pauses the flow`; `release execution_lost becomes unknown_outcome despite onFailure continue`; `early wake of a waiting run returns without work`; `inactive delegator on resume pauses the flow`; `completion publishes flow.run.completed after commit`. `runLease.test.ts`: a second `acquireRunLease` while the first is live returns null; an expired lease is taken over; `checkpoint` with a superseded token writes nothing and returns false. `runAdmission.test.ts`: second running run for the same (flow, org) refused; a parked run does not hold the slot; owner cap 20; active cap 1,000 counts parked runs. `flowRunReconciler.test.ts`: each of (a)–(e) acts, nothing else does. `flowRunRetention.test.ts`: prunes bodies only for terminal runs past the window and deletes nothing. `validate.test.ts`: the three env vars reject out-of-range values. Run → FAIL.
- [ ] **Step 2: Implement**; register `flowRunner` with `placement: 'socket-owner'` (its steps dispatch device commands, like `automationWorker` and `aiAgentRunner`) and `flowRunReconciler` / `flowRunRetention` in `WORKER_REGISTRY` and `WORKER_READINESS_MANIFEST`; add the queue payload schema.
- [ ] **Step 3: Run** the six files + `src/services/workerRegistry.test.ts` + `src/jobs/workerReadinessManifest.test.ts` + `src/jobs/scheduleRegistry.contract.test.ts` + `src/services/bullmqUtils.noColonJobIds.test.ts` + `src/config/validate.test.ts` → PASS; tsc `exit=0`.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): flow runner worker with checkpointing, approval parking, reconciler and retention (#5219)"`

### Task A9: Triggers — manual, schedule, event

**Files:**
- Create: `apps/api/src/services/flows/runService.ts`, `runService.test.ts`, `apps/api/src/jobs/flowScheduleTick.ts`, `flowScheduleTick.test.ts`, `apps/api/src/services/flows/eventTrigger.ts`, `eventTrigger.test.ts`
- Modify: `apps/api/src/services/eventSubscriberIds.ts` (`'flow-event-trigger'`), `apps/api/src/services/eventSubscribers.ts`, `workerRegistry.ts`, `workerReadinessManifest.ts`

**Interfaces:**
- Consumes: A6, A8 (`enqueueFlowRunSlice`, `assertActiveCapacity`, `assertFlowRunAdmission`), A7 `buildTriggerScope`, `coerceFlowInputs` (A1), `latestCronOccurrence` / `occurrenceKey` (`aiAgents/sweepOccurrence.ts:101,84`), `resolveFlowOwnerForCaller` (W03).
- Produces:
```ts
// runService.ts
export interface CreateFlowRunInput { flowId: string; orgId: string; triggerKind: FlowTriggerKind; triggeredVia: FlowTriggeredVia;
  scope: FlowTriggerScope; inputs: Record<string, FlowValue>; dedupeKey: string | null; chainDepth: number;
  causedByRunId: string | null; triggeredByUserId: string | null; aiSessionId: string | null; preApprovalsHonored: boolean }
export async function createFlowRun(i: CreateFlowRunInput): Promise<{ created: true; runId: string } | { created: false; reason: 'duplicate' | 'flow_queue_full' | 'not_enabled' | string; runId?: string }>;
//   system tx with explicit owner predicates; INSERT … ON CONFLICT ON CONSTRAINT flow_runs_dedupe_uq DO NOTHING (duplicate ⇒ existing id);
//   enqueue after commit (enqueueFlowRunSlice); writes audit 'flow.run.create' for manual runs.
export async function startManualRun(auth: AuthContext, flowId: string, req: FlowManualRunRequest, via: 'ui' | 'api' | 'ai_tool' | 'mcp', aiSessionId?: string | null):
  Promise<{ ok: true; runId: string; duplicate: boolean } | { ok: false; error: 'flow_not_found' | 'not_enabled' | 'not_manual' | 'org_required' | 'org_forbidden' | 'inputs_invalid' | 'flow_queue_full' | string; issues?: unknown }>;
//   flow visible in the caller's context; trigger.type === 'manual' (else not_manual); org flow ⇒ its org; partner flow ⇒ req.orgId
//   required and auth.canAccessOrg(orgId) and org.partner_id = flow.partner_id; inputs via coerceFlowInputs; dedupe
//   `manual:<idempotencyKey ?? uuid>`; preApprovalsHonored = via === 'ui' && isInteractiveUserSession(auth).
export async function cancelFlowRun(auth: AuthContext, runId: string): Promise<{ ok: true; status: FlowRunStatus } | { ok: false; error: 'run_not_found' | 'already_terminal' }>;
//   queued/waiting ⇒ cancelled now; awaiting_approval ⇒ cancel the intent (existing cancel path) — the wake marks it cancelled; running ⇒ cancel_requested_at.
export async function listFlowRuns(auth: AuthContext, f: { flowId?: string; orgId?: string; status?: FlowRunStatus; limit?: number; offset?: number }): Promise<{ runs: FlowRunSummaryDto[]; total: number }>;
export async function getFlowRun(auth: AuthContext, runId: string): Promise<FlowRunDetailDto | null>;   // caller context; RLS reach
// flowScheduleTick.ts
export async function processFlowScheduleTick(now?: Date): Promise<{ fired: number; skipped: number }>;
// eventTrigger.ts
export const flowEventTriggerSubscriber: DurableEventSubscriber;   // id 'flow-event-trigger', eventTypes '*', retry { attempts: 5, backoffMs: 30_000 }
export function eventMatchesFilter(filter: Record<string, string | number | boolean | null>, payload: unknown): boolean;
```
Schedule tick (repeatable `every: 60_000`, jobId `flow-schedule-tick`, global): system read of `flows` where `status = 'enabled'` and `definition->'trigger'->>'type' = 'schedule'`; per flow `latestCronOccurrence(cron, timezone, now)`; skip when the key equals `schedule_last_occurrence_key` or the occurrence is before `enabled_at`; target orgs = the flow's org, or (partner-wide) live orgs of the partner (`active`/`trial`, excluding the kinds `loadPartnerOrgIds` excludes, cap 500 — export `loadPartnerOrgIds` from `jobs/aiAgentSweepScheduler.ts:494` (module-private today) and reuse it); `createFlowRun` per org with dedupe `schedule:<key>` (the dedupe index makes the per-org insert idempotent, so the CAS on `schedule_last_occurrence_key IS NOT DISTINCT FROM $prev` comes after the inserts, as in `aiAgentSweepScheduler.ts` jobId-then-claim) — and only when **every** target org's admission returned `created` or `duplicate`; any other failure leaves the key unadvanced so the next tick retries the same occurrence (quorum Q3: the sweeper's catch-and-continue would silently drop that org's fire); `flow_queue_full` for an org counts as handled (logged + metric `flow_schedule_admission_refused`), not as a retry; `triggeredVia 'scheduler'`, `preApprovalsHonored true`. Missed fires: latest-only within 24 h; occurrences older than the latest are not back-filled.

Event subscriber: `!flowsEnabled()` ⇒ return; system read of enabled event flows matching `event.type` with owner `org_id = event.orgId OR (org_id IS NULL AND partner_id = <event org's partner>)`; `eventMatchesFilter` (own-property dot paths, strict equality, `null` matches missing); ancestry comes from `event.metadata.flowRunId` / `flowChainDepth` (stamped by `publishEvent` inside a flow execution frame, Decision 14) for **any** event type, and from `payload` for `flow.run.*`: skip the flow that owns `flowRunId` (no self-trigger) and use `chainDepth = depth + 1` (> 3 ⇒ no run, warn-log + metric `flow_chain_depth_refused`), recording `causedByRunId`; `createFlowRun` with dedupe `event:<event.id>`, `triggeredVia 'event'`, `preApprovalsHonored true`. The handler throws on DB failure (queue retry), never on a non-match. Registered in `registerAllEventSubscribers`.

- [ ] **Step 1: Failing tests**
  - `runService.test.ts`: `manual run on an org flow`; `partner flow without orgId is org_required`; `partner flow with an org of another partner is org_forbidden`; `inputs coerced and invalid inputs listed`; `same idempotencyKey returns the first run`; `active cap reached is flow_queue_full`; `ui run by a user session honours pre-approvals`; `api-key run does not`; `cancel queued`; `cancel parked cancels the intent`; `cancel running sets cancel_requested_at`; `getFlowRun of an invisible run is null`.
  - `flowScheduleTick.test.ts`: `due org flow fires once`; `second tick in the same minute fires nothing`; `partner-wide flow fans out one run per live org`; `occurrence before enabled_at is skipped`; `a 3-hour outage fires only the latest occurrence`; `DST fall-back hour fires once`; `one org's insert failure leaves the key unadvanced and the next tick fills only that org`; `flag off fires nothing`.
  - `eventTrigger.test.ts`: `matching filter creates a run`; `non-matching filter creates none`; `partner-wide flow matches events of its partner's orgs only`; `redelivered event creates no second run`; `own flow.run event is ignored`; `chain depth 4 is refused`; `alert event published by a flow step inherits its depth`; `event from the flow's own run is ignored whatever its type`; `DB failure throws for retry`.
  Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** the three files + `src/services/eventSubscriberRegistry.test.ts` + `src/services/eventSubscribers.contract.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): manual, schedule and durable event triggers for flows (#5219)"`

### Task A10: Routes

**Files:**
- Modify: `apps/api/src/routes/flows.ts`, `apps/api/src/routes/flows.test.ts`, `apps/api/src/services/mcpCoverage.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (only if the run/enable handlers manage their own context, as `automations` manual runs do)

**Interfaces:** keep W03 middleware order (`authMiddleware` → `requireScope('organization','partner','system')` → flag 404 → permission). New routes:
| method + path | permission | body / query | result |
|---|---|---|---|
| `POST /:id/enable` | `automations.write` | `flowEnableRequestSchema` | `EnableFlowResult` (`200` / `409 version_conflict` / `422` with `validation`, `missing`, `stepId`) |
| `POST /:id/disable` | `automations.write` | — | `{ ok, cancelledRuns }` |
| `POST /:id/runs` | `automations.write` | `flowManualRunRequestSchema` | `202 { runId, duplicate }` / `404` / `409 not_enabled` / `422 inputs_invalid` / `429 flow_queue_full` |
| `GET /:id/runs` | `automations.read` | `status?`, `orgId?`, `limit ≤ 100`, `offset` | `{ runs, total }` |
| `GET /runs/:runId` | `automations.read` | — | `FlowRunDetailDto` **without** step bodies (`renderedInput`/`output` omitted, `hasBody` flags) / `404` — the polled endpoint |
| `GET /runs/:runId/steps/:stepRowId` | `automations.read` | — | one `FlowRunStepDto` with bodies (redacted at write time; `null` after retention) / `404` |
| `POST /runs/:runId/cancel` | `automations.write` | — | `{ status }` / `404` / `409 already_terminal` |
`/runs/:runId` must be declared before `/:id` so `runs` is never parsed as a flow id. `triggeredVia` for `POST /:id/runs` = `'ui'` when the principal is an interactive user session, else `'api'`. `mcpCoverage.ts` `'flows.ts'` tools += `run_flow`, `list_flow_runs`, `get_flow_run`, `cancel_flow_run`.

- [ ] **Step 1: Failing route tests**: each route 404s with the flag off **after** auth (401 first without a token); 403 without the permission; `enable` maps every `EnableFlowResult` error to its status; `runs` returns 202 with `runId`; `GET /runs/:runId` is not captured by `/:id`; the run detail omits step bodies and the step route returns them; a step of another org's run 404s; cancel 409 on terminal. `__tests__/mcp-coverage.test.ts` fails until the entry exists. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** `src/routes/flows.test.ts` + `src/__tests__/mcp-coverage.test.ts` + `src/__tests__/routerAuthGate.contract.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): flow enable/disable, run, runs and cancel routes (#5219)"`

### Task A11: AI tools + registry contracts + index budget

**Files:**
- Modify: `apps/api/src/services/aiToolsFlows.ts` (+ test), `apps/api/src/services/flows/toolNames.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts` (`TOOL_PERMISSIONS`), `aiAgentSdkTools.ts` (`TOOL_TIERS`, `flowToolDefinitions` literal `tool('run_flow', …)` ×4, post-tool hook untouched), `aiToolExposure.ts` (`AGENT_HUMAN_ONLY_TOOLS` += `run_flow`, `cancel_flow_run`), `aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY` `automations_reports`) + `agentToolCatalog.contract.test.ts` (pinned unreachable set), `aiGuardrails.agentPrincipal.contract.test.ts` (Tier-1 list += the two reads), `aiTools.descriptionBudget.contract.test.ts` (`gated` += the four), `aiToolIndex.test.ts`, `apps/web/src/components/ai-risk/tierConfig.ts`, `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` — `FLOW_EXCLUDED_CORE_TOOLS` (`flows/catalog.ts:32`) is `new Set(FLOW_TOOL_NAMES)`, so adding the four names to `toolNames.ts` already keeps them out of flows (a flow must not start or cancel flows; W05 owns flow-as-step) — pin it with a `catalog.test.ts` case `run_flow is not flow-eligible`

| tool | tier | permission | input | output |
|---|---|---|---|---|
| `run_flow` | 3 (`supervised`; never policy-decidable) | `automations.write` | `{ flowId: uuid, orgId?: uuid, inputs?: record, idempotencyKey?: string }` | `startManualRun(auth, …, via: 'ai_tool' \| 'mcp', session)` result + `runPath: '/flows/runs/<id>'` |
| `list_flow_runs` | 1 | `automations.read` | `{ flowId?: uuid, orgId?: uuid, status?: FlowRunStatus, limit?: 1..50 }` | `{ runs, total }` |
| `get_flow_run` | 1 | `automations.read` | `{ runId: uuid }` | `FlowRunDetailDto` with each step's `output` capped at 4 KB for the model (`{ truncated: true }` marker) or `{ error: 'run_not_found' }` |
| `cancel_flow_run` | 2 | `automations.write` | `{ runId: uuid }` | `cancelFlowRun` result |

All four `domain: 'scripts'`, `deviceArgs: []`, `guarded()` (`flows_disabled` when off), MCP-gated through `FLOW_TOOL_NAMES` in `isToolEnvGatedOff`. `run_flow` is Tier 3 (Decision 11): chat raises the normal approval card ("Run flow *name*") before the handler runs, and Breeze's MCP server refuses it like every Tier-3 tool (`isMcpApprovalRequired`), so `via` is `'ai_tool'`. One exception exists: `MCP_UNATTENDED_TIER3_PRINCIPALS` (`routes/mcpServer.ts:131-168`, checked in `isMcpApprovalRequired` ~L1381) lets named API-key principals run Tier 3 over MCP — the handler therefore refuses any caller that is not an interactive user session with `run_flow_requires_chat` (an unattended MCP principal must not start flows until W05's per-flow tiers). The session id comes from the chat context only (never from input). Its approval scope is `supervised` (register it wherever tier-3 tools declare their scope) and it is not added to `POLICY_DECIDABLE_TIER3`. Descriptions ≤ 300 chars, prose only (`WORKFLOW_PROSE` rule); `run_flow`'s says starting a flow needs the user's approval and that its sensitive steps still wait for a human.

- [ ] **Step 1: Failing tests** — `aiToolsFlows.test.ts`: four handlers return `flows_disabled` with the flag off; `run_flow creates a run with pre_approvals_honored false`; `run_flow is tier 3 supervised in TOOL_TIERS and checkGuardrails`; `MCP tools/call run_flow is refused as approval-required`; `an MCP_UNATTENDED_TIER3_PRINCIPALS key reaching the handler gets run_flow_requires_chat`; `run_flow on a partner flow without orgId returns org_required`; `get_flow_run caps step outputs at 4 KB`; `cancel_flow_run of a terminal run`. `routes/mcpServer.flowsGate.test.ts`: the four new names absent from `tools/list` with the flag off. `aiToolIndex.test.ts`: `INDEX_BUDGET_BYTES = 6.75 * 1024`, comment "Tool Catalog W4 (#5219): +N B flag-on (measured), approved raise from the W3 prompt-size review (spec §11)"; the flag-on assertion now also lists the four names. Run the registry contract suites and record the red list (expected: `aiToolsRegistryParity`, `aiTools.domainMetadata.contract`, `agentToolCatalog.contract`, `aiGuardrails.agentPrincipal.contract`, `aiAgentSdkTools.mcpCoverage`, `aiAgentSdkTools.registryParity.contract`, `aiAgentSdkTools.handlerCoverage.contract`, `aiToolIndex`). Run → FAIL.
- [ ] **Step 2: Implement** until the red list is green; measure the flag-on index (`renderToolIndexByDomain(listChatSurfaceToolNames())` with `FLOWS_ENABLED=true`) and record default/flag-on bytes in the baseline doc (§11 "Tool Catalog W4 delta"). If flag-on exceeds 6912 B, stop and raise it in the PR as a Gate-B follow-up rather than trimming `DOMAIN_NOTES`.
- [ ] **Step 3: Run** the W03 Task A9 contract batch + `aiToolsFlows.test.ts` + `mcpServer.flowsGate.test.ts` → PASS; `cd apps/web && npx vitest run src/components/ai-risk` → PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(api): run/list/get/cancel flow-run AI tools behind FLOWS_ENABLED (#5219)"`

### Task A12: Integration suite and PR A wrap-up

**Files:**
- Create: `apps/api/src/__tests__/integration/flowRunsPartnerRls.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/flowsPartnerRls.integration.test.ts` (enable path)

- [ ] **Step 1: Write the suite** with the `flowsPartnerRls` helpers (`SYSTEM_CTX`, `partnerContext`, `orgContext`, `orgAuth`, `partnerAuth`, `expectSqlState`, `seedFlow`). Cases: org B inserting a `flow_runs` row with org A's `org_id` ⇒ 42501; a `flow_run_steps` row whose `org_id` differs from its run's ⇒ 23503 (composite FK); `flow_versions` XOR ⇒ 23514 and owner-guard mismatch with the parent flow ⇒ error at commit; `flow_versions` UPDATE of `definition` ⇒ raises (immutable trigger); org token reads its partner's partner-wide `flow_versions` row but cannot update it; org token sees runs of its org (including runs of a partner-wide flow) and none of a sibling org; partner token with `selected` org access sees only those orgs' runs; `action_intents` with `source='flow'` and no `requesting_flow_run_id` ⇒ 23514; two actors set ⇒ 23514; deleting a run referenced by an intent ⇒ 23503 (RESTRICT); dedupe: a second `(flow, org, 'event:x')` insert conflicts; real-DB `enableFlow` + `startManualRun` + one executed `set` step end to end in system + flow contexts; `claimFlowLinkedIntentForDispatch` refuses after a re-enable (new version) on a real row; `UPDATE flow_runs SET org_id = …` raises (immutable guard); org merge moving an enabled flow with a rewritten tenant tool pauses it `org_merged`, repoints its publications, cancels the loser org's active runs and leaves them (and their intents) in the loser org (rolled-back tx, as the W03 merge case); a later `claimFlowLinkedIntentForDispatch` on such an intent refuses `run_cancelled`; a site-restricted user's `enableFlow` is `delegation_scope_restricted` against real permission rows.
- [ ] **Step 2: Run on the wt-stack** — this file, `flowsPartnerRls`, and the Task A3 suites → PASS, each > 0 tests; paste the forge output into the PR body.
- [ ] **Step 3: Full PR A checks** — API tsc (12 GB, `exit=`), shared tsc, `pnpm lint` in `apps/api` and `packages/shared`, every unit file touched in A1–A11 (batches), `src/services/orgMerge.test.ts` (full file — it reds only in a full run).
- [ ] **Step 4: Open PR A** — title `feat(ai): Tool Catalog W04 PR A — flow runner, triggers, approval pause/resume (#5219)`; body: summary, `Part of #5219`, spec + plan paths, tenancy table (three tables, shapes, RLS, cascade, export, merge, red-first evidence), migration name, Open Decision outcomes, flag default off, the `isAutomationPrincipal` sweep list. One review round (`pr-review-toolkit:review-pr`; tenancy/RLS, the principal sweep, the release claim and pre-approval get Opus reviewers); fix confirmed findings; post the review summary.

---

## PR B — Web: enable, run, runs tab, run timeline

### Task B1: API client and locales

**Files:**
- Modify: `apps/web/src/components/flows/api.ts`, `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/flows.json`, each locale's `pages.json` (`titles.flowRun`), `apps/web/src/lib/i18n/translationCoverage.test.ts` (reviewed cognates only)
- Test: `apps/web/src/components/flows/api.test.ts` (create), `src/lib/i18n/localeParity.test.ts`, `src/lib/i18n/translationCoverage.test.ts`, `src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces (Produces):** reads `listFlowRuns(flowId, params)`, `getFlowRun(runId)` (body-less), `getFlowRunStep(runId, stepRowId)`; mutations `enableFlow(flowId, body)`, `disableFlow(flowId)`, `startFlowRun(flowId, body)`, `cancelFlowRun(runId)` — each wrapped in `runAction` with a success toast key and the caller catch pattern from CLAUDE.md (`ActionError` 401 ⇒ return; non-`ActionError` ⇒ toast). Enable's 422 body (`validation`, `missing`, `stepId`) is surfaced to the dialog, not only toasted. Remove the "read-only in this release" comment and the `previewNotice` key from every locale.

`flows.json` new keys: `tabs.overview`, `tabs.runs`, `actions.enable`, `actions.disable`, `actions.runNow`, `actions.cancelRun`, `enable.title`, `enable.body`, `enable.preApprove`, `enable.preApproveHelp`, `enable.notEligible.{not_tier3,tool_not_supported,script_not_literal,group_target,four_eyes,tenant_tool}`, `enable.missingPermissions`, `enable.eventNotDurable`, `enable.forEachConcurrency`, `enable.confirm`, `run.title`, `run.org`, `run.inputs`, `run.submit`, `run.queueFull`, `runs.empty`, `runs.status.<8>`, `runs.trigger.<manual|schedule|event>`, `runs.via.<6>`, `runs.columns.{started,status,trigger,duration,org}`, `runDetail.title`, `runDetail.back`, `runDetail.awaitingApproval`, `runDetail.openApprovals`, `runDetail.error.<FlowRunErrorCode>`, `runDetail.step.status.<7>`, `runDetail.step.approval.{none,intent,pre_approved}`, `runDetail.step.input`, `runDetail.step.output`, `runDetail.step.truncated`, `status.pausedReason.{drift,binding_drift,delegator_inactive,org_merged}`, `toast.enabled`, `toast.disabled`, `toast.runStarted`, `toast.runCancelled`. Real translations in all 8 locales.

- [ ] **Step 1: Failing tests** — `api.test.ts`: each mutation goes through `runAction` (mock asserts) and `enableFlow` rethrows a 422 `ActionError` carrying the body; parity fails until all 8 locales have the keys; `no-silent-mutations` stays green. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run → PASS. Step 4: Commit** — `git commit -m "feat(web): flow run API client and locales (#5219)"`

### Task B2: Detail page tabs, enable dialog, disable, run-now

**Files:**
- Modify: `apps/web/src/components/flows/FlowDetailPage.tsx`, `FlowStepList.tsx`, `FlowDetailPage.test.tsx`
- Create: `apps/web/src/components/flows/FlowEnableDialog.tsx`, `FlowEnableDialog.test.tsx`, `FlowRunDialog.tsx`, `FlowRunDialog.test.tsx`

Behaviour: tabs `overview` / `runs` via `useHashTab(['overview','runs'], 'overview')` (writing `window.location.hash` on change; `#step-<id>` deep links keep working on the overview tab). Header actions by status: `draft|disabled|paused` ⇒ **Enable** (opens `FlowEnableDialog`); `enabled` ⇒ **Disable** (confirm) and, for manual triggers, **Run now** (opens `FlowRunDialog`); `paused` shows the reason. Actions hidden without `automations.write`. `FlowEnableDialog`: lists Tier-3 steps; a "Pre-approve" checkbox per step the server marks eligible in `preApprovalEligibility` (Task A6), and the localized reason, disabled, for the rest; submits `{ expectedVersion, preApprovedStepIds }`; renders `missing` permissions, `validation` issues, and `event_dispatch_not_durable` inline. `FlowRunDialog`: inputs form from `definition.inputs` (types → input controls), org picker for partner-wide flows (orgs the user can access), submit ⇒ navigate to `/flows/runs/<runId>`. `FlowStepList` shows a "Pre-approved" badge for steps in the enabled version's bindings.

- [ ] **Step 1: Failing tests**: tab state follows `#runs`; Enable visible for draft and hidden without permission; dialog submits only eligible checked steps and shows a disabled reason for a four-eyes step; a 422 `missing` list renders; Disable confirm calls `disableFlow`; Run-now validates a required input before submit and navigates on success; partner-wide flow requires an org. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run** + `src/lib/__tests__/no-hash-in-usestate.test.ts` → PASS. **Step 4: Commit** — `git commit -m "feat(web): flow enable dialog with pre-approval, disable and run-now (#5219)"`

### Task B3: Runs tab and run timeline page

**Files:**
- Create: `apps/web/src/components/flows/FlowRunsTab.tsx`, `FlowRunsTab.test.tsx`, `FlowRunPage.tsx`, `FlowRunPage.test.tsx`, `FlowRunTimeline.tsx`, `useFlowRunPolling.ts`, `useFlowRunPolling.test.ts`, `apps/web/src/pages/flows/runs/[runId].astro`
- Modify: `apps/web/src/lib/routeScope.test.ts` (the existing `/^\/flows(\/.*)?$/` pattern already covers it — assert, don't add)

Behaviour: `FlowRunsTab` — `ResponsiveTable` of runs (started, status chip, trigger + via, duration, org for partner-wide flows), status filter, row → `/flows/runs/<id>`; polls every 10 s while any visible run is active. `FlowRunPage` — header (flow name link, version, status, trigger, org, error code + localized message), "Awaiting approval" banner linking `/approvals` when parked, Cancel for active runs; `FlowRunTimeline` renders steps in definition order merged with step rows (unreached steps greyed, skipped marked, for-each items nested, approval mode badge, approver, duration, collapsible rendered input / output with the truncation note). `useFlowRunPolling(runId)` — polls the body-less run detail every 3 s while non-terminal; never overlaps requests (the next poll is scheduled after the previous settles); stops on terminal; pauses when `document.hidden`; backs off to 15 s after 5 min; after 3 consecutive failures shows a "Live updates paused — retry" notice with the last-updated time instead of silently freezing. Step bodies load lazily from `GET /runs/:runId/steps/:stepRowId` when a step is expanded. The header distinguishes the four kinds of not-moving — `awaiting_approval` (link to `/approvals`), `waiting` (shows `wake_at`), `queued` behind a busy slot ("Queued"), and `unknown_outcome` (explains that the step may have run and must be checked by hand).

- [ ] **Step 1: Failing tests**: runs list renders rows and links; polling stops at a terminal status (fake timers); hidden tab pauses polling; timeline shows an unreached step greyed and a for-each step with 3 items; awaiting-approval banner links to `/approvals`; Cancel calls `cancelFlowRun` and refetches. Run → FAIL.
- [ ] **Step 2: Implement. Step 3: Run → PASS** + `npx astro check`. **Step 4: Commit** — `git commit -m "feat(web): flow runs tab and run timeline with polling (#5219)"`

### Task B4: Approval card context and docs

**Files:**
- Test: `apps/web/src/components/approvals/ApprovalsInbox.test.tsx` (extend)
- Create/modify: the Flows page under `apps/docs/` beside the automations docs (use the `update-breeze-docs` skill for location and frontmatter)

- [ ] **Step 1: Failing test**: an approval DTO with `requestingClientLabel: 'Flow Disk cleanup'` and `actionLabel: 'Step cleanup: run_script'` renders both on the card (server labels from Task A5). If it passes without a code change, keep the test as the pin and change nothing in the inbox.
- [ ] **Step 2: Docs** — what a flow is, enabling and the delegation it implies (rule 7), pre-approval eligibility and why AI-started runs never use it, the event-trigger deployment prerequisite (`EVENT_DISPATCH_MODE=enforce` + `EVENT_DISPATCH_QUEUE_SUBSCRIBERS` including `flow-event-trigger`), limits, `FLOWS_ENABLED`. No internal hostnames.
- [ ] **Step 3: Commit** — `git commit -m "docs(flows): enabling, approvals and triggers; pin flow context on approval cards (#5219)"`

### Task B5: PR B wrap-up and live check

- [ ] Run `cd apps/web && npx vitest run src/components/flows src/components/approvals src/lib/i18n src/lib/__tests__ src/lib/routeScope.test.ts` (batches) && `npx astro check` && `pnpm lint`.
- [ ] Boot the wt-stack with `FLOWS_ENABLED=true`, `EVENT_DISPATCH_MODE=enforce`, `EVENT_DISPATCH_QUEUE_SUBSCRIBERS=flow-event-trigger`. Draft in chat "every 5 minutes list offline devices, then run script <seeded script> on device <seeded device>"; enable with the script step **not** pre-approved; wait for the tick; approve the parked step in `/approvals`; confirm the run timeline completes with the approver recorded. Re-enable with the step pre-approved; Run now from the UI ⇒ no approval; `run_flow` from chat ⇒ parks. Edit the script content ⇒ next run `binding_drift`, flow paused. Screenshots in the PR. Tear the stack down and say so.
- [ ] Open PR B (title `feat(web): Tool Catalog W04 PR B — enable, run, runs tab and run timeline (#5219)`, body `Closes #5219`, stacked on PR A) → `gh workflow run CI --ref <branch>`; one review round; summary comment. Merge order A → B with bare `gh pr merge`.

---

## Exit checklist (wave done when every box is true)

- [ ] Migration `2027-01-02-150000-flow-runs.sql` sorts last at merge time, re-runs cleanly, `pnpm db:check-drift` clean; every `org_id` FK and the `(run_id, org_id)` composite FK `DEFERRABLE INITIALLY IMMEDIATE`.
- [ ] `flow_versions` in `DUAL_AXIS_TENANT_TABLES` + `XOR_OWNERSHIP_DUAL_AXIS_TABLES`; all three tables in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (every column), `orgMergeRegistry`; new `flows` / `action_intents` columns classified; contract suites green on a real DB with red-first evidence.
- [ ] `flowRunsPartnerRls.integration.test.ts` and `flowsPartnerRls.integration.test.ts` green on the stack and in CI's Integration Tests job.
- [ ] Every `'ai_agent'` principal comparison classified in `automationPrincipal.contract.test.ts`.
- [ ] Approved Tier-3 flow steps execute only through `intentReleaseWorker` behind `claimFlowLinkedIntentForDispatch` (lost race = no-op); drift, deny, expiry, cancel, `execution_lost` each end the run with the documented status.
- [ ] Pre-approval only for eligible, variable-free `run_script` steps, honoured only for schedule/event/UI runs, content-digest bound; enable refuses site- or org-restricted delegators.
- [ ] Every runner write is lease-fenced; a superseded slice writes nothing.
- [ ] Runs and steps are `leave-for-erasure` on merge with an immutable `org_id`; retention prunes bodies and deletes no rows.
- [ ] Schedule tick, event subscriber (enable gated on durable delivery), manual route/UI/`run_flow` all create runs through `createFlowRun` with permanent dedupe and the active-run cap; the W05 seam `assertFlowRunAdmission` is called on every path.
- [ ] Reconciler + retention registered in `WORKER_REGISTRY` and the readiness manifest.
- [ ] Four tools registered (tier — `run_flow` Tier 3 supervised —, domain, schema, permission, capability, exposure, `mcpCoverage`); index ≤ 6912 B flag-on, measured value recorded.
- [ ] Web: tabs via `useHashTab`, enable/disable/run/cancel through `runAction`, timeline polling stops on terminal, 8 translated locales, `astro check` clean.
- [ ] Spec amended (Task A0).
- [ ] Deferred to W05 (#5220), handed to the orchestrator: webhook trigger, `flow__<slug>` registration (+ agents calling flows, `run_flow` leaving `AGENT_HUMAN_ONLY_TOOLS`), for-each concurrency, `notify`/`ai`/`http_request`, budgets + monthly caps behind `assertFlowRunAdmission`, the policy-decidable pre-approval lane, per-flow `run_flow` tier (async tier resolver), live-variable pinning for variable-dependent pre-approval, a site-ceiling on publications; `action_intents.requesting_flow_run_id` already exists (W05 only uses it). Known platform limitation carried, not fixed: event route-enqueue failure drops the event (`eventDispatchQueue.ts:12`).

## CI traps

- Contract suites (RLS coverage, cascade, export, erasure, org-merge, merge-contract DEFERRABLE check in `orgLifecycleFoundations`) run only under **Integration Tests**; `orgMerge.test.ts` reds only in a full unit run.
- PR B is stacked ⇒ no automatic CI; `gh workflow run CI --ref <branch>` and key the wait on branch + head SHA (`gh run list --commit` can miss runs).
- `aiAgentSdkTools.mcpCoverage.test.ts` greps for literal `tool('<name>'` — no `.map()` over names.
- `aiToolIndex.test.ts` / `aiTools.descriptionBudget.contract.test.ts` read env at call time — `vi.stubEnv` + `vi.unstubAllEnvs`.
- BullMQ jobIds must not contain `:` (`bullmqUtils.noColonJobIds.test.ts`) — use `bullmqJobId(...)`; dedupe keys in Postgres may keep `:`.
- `tsc` OOM under a pipe reads as green — always `echo "exit=$?"`.
- Widening `action_intents.source` touches exhaustive switches in chat/MCP/agent code — let tsc find them; do not add a `default` that swallows `'flow'`.
- `check-migration-naming.sh` runs pre-commit; if `150000` is taken, take the next free `HHMMSS` and say so.

## Self-review (done at authoring)

- **Spec coverage (W04 row + §6.3 rules 4/7, §6.4 runs, §6.5, §6.7 runs page, §6.8):** tables (A2, A3, A12), principal (A4), approvals pause/resume + drift (A5, A8), lease/fencing and loop ancestry (A5, A7, A8), enable + rule 4/7 + slug + event check (A6), runner incl. checkpointing, unknown outcome, cancel, wait, for-each, limits, loop prevention, completion events (A7, A8), triggers + execution org (A9), routes (A10), tools (A11), runs UI (B2, B3), approval card context (B4). W03 carry-forwards: rule 4 lane + binding + toggle (A6, B2), rule 7 (A6), event-dispatch check at enable (A6, Decision 10), definition snapshot (Decision 2), run-time re-validation of masked inputs + templated-id ownership (A6 `revalidateRenderedStep`, A7), `assertFlowSlugAvailable` under `lockFlowSlugsForPartner` on enable (A6). Not folded: branding `ToolOwnerRef` and making `SaveDraftFlowResult` a discriminated union on `error` — both are type-only refactors across W1/W3 call sites with no W04 consumer; filed as W05 cleanup rather than widening this diff.
- **Placeholders:** none; implementer judgment points are named with their source (the principal-site classification in A4 Step 1; the transient-error classifier in A7 — reuse if present).
- **Type consistency:** `FlowRunStatus`, `FlowRunStepStatus`, `FlowTriggerKind`, `FlowTriggeredVia`, `FlowRunErrorCode`, `FLOW_RUN_LIMITS`, `FlowRun*Dto`, `FlowStepPin`, `FlowPreApprovalBinding`, `scriptPreApprovalMaterial`, `revalidateRenderedStep`, `stepPinsFor`, `enableFlow`, `disableFlow`, `pauseFlow`, `buildFlowAuthContext`, `isAutomationPrincipal`, `isFlowPrincipal`, `claimFlowLinkedIntentForDispatch`, `scheduleFlowRunWake`, `withFlowExecutionContext`, `executeFlowStep`, `buildTriggerScope`, `enqueueFlowRunSlice`, `acquireRunLease`, `checkpoint`, `claimRunSlot`, `assertActiveCapacity`, `assertFlowRunAdmission`, `enabled_publication_seq`, `createFlowRun`, `startManualRun`, `cancelFlowRun`, `listFlowRuns`, `getFlowRun` are used with the same names in every task.
- **Proportion:** names, signatures, values, statuses, error codes and test names are pinned; bodies appear only for the migration DDL list, the `executeFlowStep` order, and the runner loop, which the signatures do not determine.
