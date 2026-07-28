# Design — Tier-3 approval parity in chat plan mode

**Date:** 2026-07-27
**Status:** design approved; revised after independent review (Fable + Codex gpt-5.6, both read-only)

Companion: `internal/security/tier3-plan-mode-intent-bypass.md`.

> **Revision note.** The first draft was wrong in three ways, all caught by review and all
> corrected below: it understated and mis-specified the blast radius (effective tier, not
> static tier); it claimed plan mode was the *only* tier-3 path without a durable intent
> (false — external MCP and helper/PAM have their own models); and its fix compensated for
> a premature index advance with an abort that covered only 4 of ~9 exits. The index advance
> is now **deferred** instead. Scope is deliberately narrowed to the core bypass; three
> adjacent defects are recorded in §8 as follow-ups.

---

## 1. Problem

In `action_plan` / `hybrid_plan` mode, a tool call matching an approved plan step returns
`{ allowed: true }` (`aiAgentSdk.ts:455`) **before** the tier-3 branch that creates the
durable `action_intents` row (`:579`). A tier-3 action therefore executes with no intent
row, no argument-digest binding, no approver-pool fan-out, and **no second approver** — the
same user drove the agent and approved the plan.

`propose_action_plan` validates steps only for `TOOL_TIERS` membership
(`aiAgentSdkTools.ts:1987-1994`), never tier value, so every tier-3 tool is a legal step.

### 1.1 The policy already exists; plan mode doesn't implement it

The adjacent `auto_approve` branch enforces the correct rule (`aiAgentSdk.ts:402-404`):

```ts
// Auto-approve mode only skips approval for Tier 2 tools. Tier 3+
// tools still require an explicit per-step approval.
if (effectiveMode === 'auto_approve' && guardrailCheck.tier === 2) {
```

The plan branch below has no tier check. The mode named *auto-approve* is stricter on tier-3
than plan mode. This design applies existing policy consistently; it does not create policy.

### 1.2 Blast radius — effective tier, not static tier

**Corrected.** The vulnerable value is the **escalated** tier. Many tools are tier 1/2 in
`TOOL_TIERS` and reach tier 3 only via `TIER3_ACTIONS` action-escalation in `checkGuardrails`
(`aiGuardrails.ts:89-126`, applied at `:730-737`) — `file_operations` read/write/delete,
`disk_cleanup: execute`, `manage_automations: run`, `manage_patches: install/rollback`,
`registry_operations: set_value/create_key/delete_key`, `manage_processes: kill`, and ~20 more.

So the affected set is "every tool call whose **effective** tier is 3", which is materially
larger than the base-tier-3 list and cannot be enumerated by tool name alone — it depends on
the action argument. Any count stated by tool name is misleading; do not restate one.

### 1.3 Permission gap

| Path | Permission | Approver |
|---|---|---|
| Approved plan | `organizations:write` + MFA (`routes/ai.ts:128`, `:865-869`) | the session user |
| Durable intent | **`approvals:decide`** (`db/seed.ts:292`) | a durable approval decision — a second approver, or an L3 WebAuthn self-approval in sole-operator orgs |

### 1.4 What is NOT bypassed

The tool executes under the session's own `AuthContext`, so RBAC, permissions, org-scoping
and RLS all still apply. Not privilege escalation, not an authentication bypass, not
cross-tenant. What is lost is governance: four-eyes, the immutable record, digest binding.

Severity is further bounded per tool. `delete_tenant` — the most alarming name — has three
rails this bypass doesn't touch (self-tenant only, exact confirmation phrase, soft-delete
with a 30-day restore window). It matters most for tools acting irreversibly on customer
devices with no equivalent rails: `execute_command`, `run_script`, `computer_control`,
`s1_isolate_device`, `google_wipe_mobile_device`, plus the action-escalated set in §1.2.

### 1.5 Surface-policy matrix — this fix covers ONE surface

**Corrected.** The first draft claimed plan mode was the only tier-3 path lacking a durable
intent. It is not. Different surfaces use different, deliberate authorization models:

| Surface | Tier-3 model | In scope here |
|---|---|---|
| Interactive chat, `per_step` | Durable intent + approver-pool fan-out + second approver | already correct |
| Interactive chat, `auto_approve` | Falls through to the durable branch (tier-2 only shortcut) | already correct |
| **Interactive chat, `action_plan`/`hybrid_plan`** | **none — the defect** | **YES** |
| External MCP / API-key | Deliberate: auto-executes tier-3, no intent. Gated on `ai:execute`, `ai:execute_admin` in prod, prod allowlist, RBAC, rate limit (`mcpServer.ts:961-1000`) | no — documented policy |
| Helper / PAM | PAM elevation governance + `waitForApproval`, no action intent; can policy-auto-approve (`aiAgentSdk.ts:321-397`, `pamToolActionGovernance.ts:116-135`) | no — deliberate carve-out |
| Scheduled automation | Authorized at definition time (permission + MFA), not per-run (`automationRuntime.ts:834-967`) | no |
| Playbooks | Record-only today; no runner executes the declarative steps (`aiToolsPlaybooks.ts:104-235`) | no — see §8 |

**Do not claim, in the spec, the PR, or a release note, that after this fix every tier-3
action has a durable intent and a second approver.** That is true only of the interactive
chat session surface.

Verified safe (no change needed): paused sessions (`isPaused` forces `per_step`, `:400`),
the plan-deviation path (no match → falls through, `:479`), and non-session `makeHandler`
tools (same `createSessionPreToolUse` gate).

## 2. Approach

Within the interactive chat surface, tier-3 means tier-3 in every approval mode. A plan's
approval covers effective tiers 1-2; an effective-tier-3 step still creates its intent, fans
out, and waits for a second person.

Rejected: rejecting tier-3 at `propose_action_plan` (louder behaviour change, no security
gain over fall-through); creating intents at plan-approval time (better UX, materially more
work, creates intents for steps that may never run); durable resumable plans (a feature).

## 3. Changes

### 3.1 Tier-gate the plan shortcut

`aiAgentSdk.ts:431`:

```ts
if (match.matches && guardrailCheck.tier < 3 && !isSecretBearingTool(toolName)) {
```

**The gate MUST read `guardrailCheck.tier`, never `TOOL_TIERS[toolName]`.** `guardrailCheck`
is computed once at `:279` and is the *effective, post-escalation* tier; the same object
feeds the tier-3 branch at `:579`, so the two cannot disagree. Substituting the base map —
an obvious-looking "simplification" — silently preserves the bypass for every
action-escalated tool in §1.2. Both reviewers flagged this independently.

Retain the `isSecretBearingTool` clause though `tier < 3` now subsumes it: defence in depth
against a future mis-tiering, and it keeps PR #2853's invariant explicit.

Tier ≥ 4 needs no handling: blocked/unknown tools return `allowed:false` at `:281`, before
the plan block, and `createActionIntent` throws `tool_blocked` for tier ≥ 4
(`intentService.ts:203`).

### 3.2 Defer the plan-index advance until the step is authorized

**This replaces the first draft's approach and is the most important change.**

Today the matched-but-declined branch advances `session.currentPlanStepIndex` at `:477`
*before* intent creation, the approval wait, the release CAS and revalidation. Compensating
for that with an abort was insufficient: the abort covered 4 decision statuses, but at least
five other exits return `allowed:false` after the advance with no abort — ledger-insert
failure (`:497-520`), intent-creation failure (`:600-612`), lost release CAS (`:697-716`),
revalidation failure, and thrown errors. On each, `activePlanId` is still set and the index
is stale, so post-use emits `plan_step_complete` off it (`:979-989`) and can mark a plan
`completed` for a step that never ran (`:1206`).

Instead: **do not advance on the decline path at all.** Carry the matched step index down to
the tier-3 branch in a local, and advance only once the step is genuinely authorized —
immediately before the tier-3 branch returns `{ allowed: true }`, after the release CAS is
won. Emit `plan_step_start` at that same point (it is currently suppressed entirely, which
was defensible for two rare tools and is not once this is the common tier-3 path).

This eliminates the class rather than patching exits: every failure path leaves the index
untouched, so nothing needs unwinding.

It also closes a window neither draft addressed: between the advance and the abort the plan
was live with an advanced index for up to 300 s. That is safe **only** under sequential
intra-turn tool dispatch (which the FIFO `toolUseIdQueue` at
`streamingSessionManager.ts:649` / `aiAgentSdk.ts:947` already assumes). Deferring removes
the dependency on that assumption instead of documenting it.

Post-use's plan blocks are gated on `session.activePlanId` (`:979`, `:1206`) — verified — so
once §3.3 aborts, they correctly no-op.

### 3.3 Abort the plan when a tier-3 step is not authorized

`abortActivePlan` (`:1334`) exists but is only called from pause (`routes/ai.ts:842`) and the
explicit abort endpoint (`:973`). Call it before returning `{ allowed: false }` from the
tier-3 branch whenever `session.activePlanId` is set — for **every** non-executing exit, not
only the four decision statuses: denied/cancelled/expired, wait timeout, ledger failure,
intent-creation failure, lost release CAS, revalidation failure, and thrown errors.

With §3.2 the index is no longer stale, so abort is about stopping the plan rather than
unwinding state — without it the plan stays active and the model may retry the same step.

`abortActivePlan` swallows its own DB error and still clears in-memory state
(`:1347-1350`, `:1360-1362`) — verified — so the tool's return must not depend on the abort
succeeding.

### 3.4 Message accuracy

The pending message (`:676-679`) — *"Approval still pending; this action will complete once
approved."* — is correct that the intent stays live. It must also say the plan has stopped.
Both are true; an operator reading only the first half assumes the plan is still running.

## 4. Deliberately unchanged

`auto_approve`; `propose_action_plan` validation (the agent may still propose tier-3 steps);
`waitForIntentDecision`'s no-write-on-timeout; plan durability/resumability; and every
non-chat surface in §1.5.

## 5. Error handling

All paths fail closed — no tier-3 action runs without a durable approval.

1. **Denied / cancelled / expired** — plan aborts; intent already terminal; nothing runs.
2. **In-chat wait expires** (300 s, `:670`) — plan aborts; the intent stays
   `pending_approval` and a later approval still executes it via the release worker.
   **Straggler hazard, stated plainly:** an aborted plan can still fire exactly one tier-3
   action later, out of band, against state the earlier steps already mutated, with none of
   the following steps. Worked example: `[s1_isolate_device, run_script, un-isolate]` — step
   1 times out, the plan aborts, an approver approves 20 minutes later, the device isolates
   and the remediation and un-isolate steps no longer exist. This is accepted (tier-3
   approval is durable and outlives the chat, exactly as in `per_step`), but it must be
   surfaced in the UI copy and the release note, not just tolerated.
3. **Ledger / intent-creation / CAS / revalidation failure, or a throw** — plan aborts; no
   intent reaches an executable state.

## 6. Testing

Both `action_plan` and `hybrid_plan` — they share one condition and a single-mode matrix
would miss a mode-specific regression.

1. **Effective-tier-1/2 steps still take the shortcut.** Highest-value guard: over-broadening
   silently disables plan mode for every ordinary tool.
2. **An action-escalated step is gated** — e.g. `file_operations` with `action: 'read'`,
   base tier 1, effective tier 3. This is the test that proves the gate reads
   `guardrailCheck.tier` and not `TOOL_TIERS`; it passes under a wrong implementation that
   only checks base tier for statically-tier-3 tools.
3. **An effective-tier-3 step does not shortcut** and creates an intent.
4. **Approved** → executes; index advances only now; `plan_step_start` emitted; plan continues.
5. **Denied → plan aborts AND a following step does not execute.**
6. **Every non-executing exit aborts the plan** and leaves `currentPlanStepIndex` unchanged —
   cover at least denial, timeout, and a forced intent-creation failure.
7. **Timeout** → plan aborts; intent stays `pending_approval` and is still executable by the
   release worker.
8. **Secret-bearing tools** keep PR #2853 behaviour.
9. **Plan UI event sequence** — an approval-gated step now emits `approval_required` then
   `plan_step_start` then `plan_step_complete`. Verify the web plan view renders that
   correctly; previously such a step emitted no `plan_step_start` at all, which was a rare
   edge and becomes the common case.

Every load-bearing test verified by injection — delete or invert the line, observe the
failure, restore, paste the real output. Across PR #2853's ten tasks, every one initially
shipped a test that would have passed with the feature deleted.

## 7. Tenancy

No schema changes, no new tables, no new `org_id` columns. No RLS shape and none of the four
cascade lists are affected.

## 8. Out of scope — tracked follow-ups

Found by review, real, deliberately **not** in this change to keep one reviewable unit. The
first two are prioritised ahead of the rest — both are direct consequences of making
durable-intent waits the common case for plan steps rather than a rare corner:

1. **Stale approval card.** `processStreamEvent.ts:132` is the only write to `pendingApproval`
   and only ever sets it; the three clearing paths are all in `aiStore.ts` (new message, own
   decide, explicit action). No stream event clears it, so a four-eyes card decided by a
   *different* admin never self-clears. This branch makes that the normal outcome of every
   four-eyes plan step, and `processStreamEvent.ts:200-206` clears the plan panel 3 s after
   `plan_complete`, leaving an orphaned Approve/Reject card with no plan context.
2. **Turn-budget undersized for plan mode.** `streamingSessionManager.ts:38` sets
   `SDK_TURN_TIMEOUT_MS = 6 min`, commented as accounting for "tool approval waits up to
   5 min" — singular. Every effective-tier-3 plan step now waits up to 300 s, so two such
   steps in one turn exceed the budget. On expiry (`streamingSessionManager.ts:576-583`) the
   manager publishes `error` + `done` but does NOT abort the plan, trip the abort controller,
   or cancel the in-flight intent — so an approval landing later still executes after the
   operator was told the request timed out.
3. **Stop/pause does not cancel a pending plan-owned intent.** `abortActivePlan` neither
   cancels the intent nor signals the waiter, so an approval arriving after the operator hits
   Stop still executes — inline (the post-wait path never rechecks the plan) or via the
   worker (`intentReleaseWorker.ts:242-367`). Operator-visible surprise: "I stopped it and it
   ran anyway." Fix shape: durably bind plan-origin intents to `{planId, stepIndex}`; cancel
   linked `pending_approval|approved` intents on explicit abort/pause; have release recheck
   the parent plan is still executable.
4. **Stale `planApprovalResolver` after abort.** `propose_action_plan` sets `activePlanId`
   before waiting (`aiAgentSdkTools.ts:2032-2043`); abort clears the id but not the resolver,
   so a later approval resolves a dead promise (`routes/ai.ts:895-914`) and the continuation
   repopulates steps and marks the aborted plan executing (`aiAgentSdkTools.ts:2055-2074`).
5. **Out-of-band execution strands the `ai_tool_executions` row.** Approval rows carry
   `intentId`, not `executionId` (`intentService.ts:374-387`); post-use only updates rows
   already `executing` (`:1063-1082`); the worker terminalizes only the intent. The stale row
   corrupts status counts and success rates in the admin feed (`routes/ai.ts:1188-1286`).

Also noted, no action now: playbook fan-out binds the digest to the playbook invocation, not
to each downstream device action — needs effective-tier enforcement before any runner ships.

## 9. User-visible change

A plan containing an effective-tier-3 step now stops there until a durable approval decision
is made — a second approver, or an L3 WebAuthn self-approval in sole-operator orgs.
That is the intent, but it is a visible behaviour change for anyone relying on plan mode to
run destructive steps unattended. The release note must also state §5.2's straggler: a
stopped plan's pending step may still execute later if approved.
