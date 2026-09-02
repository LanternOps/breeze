---
tracking_issue: LanternOps/breeze#3821
wave: W06 (#3827) — Part B (the policy-decide lane)
---

# Wave 5 Part B — Policy-Decide Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bounded unattended Tier-3 goes live (dark): an agent-originated `supervised`-scope intent whose operation the OPERATOR explicitly authorized (per-agent `actAssets.supervisedActionKeys` ⊆ the `POLICY_DECIDABLE_TIER3` registry) is authorized by policy — atomically reserving org-wide blast capacity, stamping durable provenance, skipping human fanout — and executes through the EXISTING release pipeline with a new policy-evidence branch; everything else (unauthorized keys, cap overflow, drift, kill) degrades to the normal human intent. Everything sits behind `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` (default off).

**Architecture:** `resolvePolicyDecisionState` (Part A's stub) becomes real: agent-originated + supervised + flag on → state `unattempted`, fanout NOT run, and `attemptPolicyDecision(intentId)` is invoked post-commit (plus at-least-once recovery via the outbox `intent_created` consumer branch for `unattempted` intents). The attempt pipeline: canonical key → registry ∧ headlessCompatible ∧ agent authorization → live guardrail re-run → kill state → caps (`maxFleetPercentPerDay` floor() over `ai_unattended_exposure` distinct devices ∪ act-lane rows, `maxPolicyDecisionsPerDay`) → ONE transaction: exposure reservation insert + CAS `pending_approval → approved` + `decidedVia:'policy'`/NULL user/NULL assurance + provenance columns + `policy_decision_state:'authorized'` + outbox `intent_approved`. Deterministic failure → CAS state `unattempted → human_required` + `runHumanFanout` (the deferred fanout from Part A). Transient failure → leave `unattempted` for redelivery. Release: `revalidateApprovedIntentForRelease` gains a policy-evidence branch (NO human approval row required when `decidedVia === 'policy'` — instead: digest recompute + registry/authorization re-check in BOTH snapshot and current policy + kill-epoch sanity + final pre-effect kill re-read); `checkAgentReleaseAuthority`'s predicate for policy-decided intents requires exact current authorization, not merely not-denied. The wave-4 act lane starts writing exposure rows too (shared accounting) and gains the fleet-percent cap. Approvals UI renders "authorized automatically by policy"; the agent form edits `supervisedActionKeys` with the act-mode acknowledgement pattern.

**Tech Stack:** TypeScript, Drizzle, Vitest (+ web + i18n). **No migrations** (`supervisedActionKeys` extends the existing `act_assets` jsonb; everything else landed in Part A). One new env var (full parity ceremony).

**Design authority — LOCKED quorum decisions (2026-08-28), do not relitigate:** policy is a mechanism, not a principal (`decidedVia:'policy'`, NULL user, NULL assurance — no sentinel, no synthetic human approval row EVER); fanout only after `human_required`; deterministic-vs-transient failure distinction is load-bearing (a crashed attempt must be distinguishable from a rejected one); org-wide exposure numerator = distinct devices across ALL unattended mutating executions (act + policy) trailing 24h; allowance = `floor(fleet × pct/100)` with NO `max(1,·)` (zero allowance for tiny fleets is correct; the operator raises pct) + the absolute day cap as a second ceiling; denominator = `countContractDevices(orgId, null)`; reservation atomic with the approval CAS (DB-backed, never count-then-write); release must re-check authorization in snapshot AND current policy + a final pre-effect kill read; four_eyes/T4/secrets/`decideHandler` untouched; stored authorization keys tolerated-but-inert when the registry drops them; run outcome must distinguish policy-authorized from awaiting_approval.

## Global Constraints

- **Dark-ship**: flag off → `resolvePolicyDecisionState` returns `human_required` exactly as Part A (byte-identical inertness); every new path is unreachable. The flag: `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` (bool, default false) — env.ts + validate.ts + `.env.example` + BOTH compose api env anchors (`envComposeParity` enforces).
- Run tests as `cd apps/api && npx vitest run <path>`; typecheck with heap bump; shared edits: `pnpm --filter @breeze/shared test`; new web strings in every locale (tr-TR parity).
- The exposure reservation + approval CAS + provenance + outbox MUST be one transaction (the quorum's oversubscription requirement). The fleet count reads inside that transaction (`SELECT count(DISTINCT device_id) FROM ai_unattended_exposure WHERE org_id = … AND reserved_at > now() - interval '24 hours'` FOR the insert-guard — document why plain READ COMMITTED + the reservation insert is race-acceptable: two concurrent attempts can each read N-1 and both insert, overshooting by one device max per race; mitigate with a per-org advisory xact lock `pg_advisory_xact_lock(hashtextextended('ai-exposure:' || org_id, 0))` inside the transaction — cheap, correct, single-row-hot).
- Do-not-touch inventory (byte-identical): `decideHandler`'s human gate, `createActionIntent` tier guards, TIER3_FOUR_EYES sets, secret-bearing denies, the human decide CAS path.
- Ledger retention: 48h sweep — extend an EXISTING retention worker family (grep the retention workers registered in `workerRegistry`; add `aiUnattendedExposureRetention` following the closest sibling's shape, registry + snapshots 106 → 107 with the closure contract verdict).
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/actionIntents/policyDecide.ts` (new) | `attemptPolicyDecision` pipeline + the atomic authorize transaction + caps. |
| `apps/api/src/services/actionIntents/intentService.ts` (modify) | Real `resolvePolicyDecisionState`; post-commit attempt trigger; `human_required` degrade path callable post-creation. |
| `apps/api/src/jobs/intentReleaseWorker.ts` + `services/actionIntents/revalidateRelease.ts` + `agentReleaseAuthority.ts` (modify) | Policy-evidence release branch + stricter predicate + final pre-effect kill read. |
| `apps/api/src/services/aiAgents/actRevalidation.ts` (modify) | Act-lane exposure-row writes + fleet-percent cap. |
| `apps/api/src/jobs/aiUnattendedExposureRetention.ts` (new) + `workerRegistry.ts` | 48h ledger sweep. |
| `packages/shared` (modify) | `AiAgentActAssets.supervisedActionKeys`, validator (keys validated via `validateAuthorizationKeys`), effective-policy intersection merge. |
| `apps/api/src/services/aiAgents/agentService.ts` + `routes/aiAgents.ts` (modify) | Write-time key validation + act/policy prerequisites surface. |
| `apps/api/src/routes/approvals.ts` (read paths) + `apps/web` approvals + agent form (modify) | Null-decider tolerance + "authorized automatically by policy" + `supervisedActionKeys` editor. |
| env/validate/compose/.env.example (modify) | The sub-flag. |

---

### Task 1: `supervisedActionKeys` + flag + merge semantics

- Shared: `AiAgentActAssets` gains `supervisedActionKeys?: string[]` (validator: max 50, each key validated by `validateAuthorizationKeys` from `policyDecidable.ts` — write-time rejection of unknown/four_eyes/T4/secret keys with a structured 422). Effective-policy merge: org may only NARROW partner baseline (set intersection; absent partner field ⇒ org value stands alone iff the agent row IS the partner baseline — mirror how `scriptIds` merges today, grep it and match exactly). Snapshot: rides `actAssets` (v3 already tolerant).
- Env flag full parity ceremony + `policyDecideEnabled()` helper (eventDispatchMode style).
- [x] TDD (validator matrix, intersection merge, flag helper) → commit: `feat(shared,api): supervisedActionKeys authorization set + policy-decide flag (#3827)`

---

### Task 2: `attemptPolicyDecision` + the real `resolvePolicyDecisionState`

- `resolvePolicyDecisionState(inserted, ctx)`: `'unattempted'` iff flag on ∧ agent-originated ∧ `approvalScope === 'supervised'`; else `'human_required'` (flag off ⇒ Part-A behavior byte-identical — assert with the full intentService suite).
- `createActionIntent`: when state `unattempted`, skip `runHumanFanout`, still write outbox `intent_created`; post-commit (AFTER the transaction — never inside), fire-and-forget `attemptPolicyDecision(inserted.id)` with error swallow (outbox redelivery is the safety net).
- `attemptPolicyDecision(intentId)`: load intent (state must be `unattempted`, status `pending_approval`, not expired — else no-op); canonical key from `actionName` + `arguments.action` (multiplexed tools use `tool:action`; derive EXACTLY the way `checkGuardrails` resolves the action — reuse its resolution helper, never re-implement); pipeline per the header. Deterministic failures (key not in registry / not headlessCompatible / not in effective `supervisedActionKeys` / guardrail non-allow / kill engaged / caps exhausted / intent expired) → CAS state `unattempted → human_required` + `runHumanFanout` via a new exported `runDeferredHumanFanout(intentId)` (re-derives the approver pools the way creation did — extract what's needed; the fanout must produce the SAME approval rows + notifications creation would have) + if fanout yields zero approvers, the existing no-eligible-approver cancellation semantics. Transient failures (DB/Redis errors) → log + leave `unattempted`.
- The authorize transaction (all-or-nothing): `pg_advisory_xact_lock` on the org exposure key → fleet-percent check (distinct exposure devices ∪ {this device} vs `floor(countContractDevices × maxFleetPercentPerDay/100)`) → day-cap check (count policy-authorized intents for this agent's org trailing 24h — count exposure rows `source='policy_intent'`) → insert exposure row (`source:'policy_intent'`, intent_id, run/agent/device/org) → CAS intent `pending_approval → approved` + `policy_decision_state:'authorized'` + `decidedAt` + `decidedVia:'policy'` + NULL decider/assurance + provenance (key, snapshot digest = the run's `policySnapshot` content hash — reuse/extract the digest helper the release evidence will recompute, classification version, reservation id = exposure row id, kill epoch) → outbox `intent_approved`. Audit: `initiatedBy: 'policy'`, actorType `'system'`, agent/run/key in details. Notification to recipients ("authorized automatically by policy — executing").
- Outbox recovery: `processIntentReleaseJob`'s `intent_created` branch (currently no-op) → when the intent is agent-originated ∧ `policy_decision_state === 'unattempted'` ∧ flag on → `attemptPolicyDecision`; else no-op as today.
- [x] TDD: the full matrix (each deterministic failure → human_required + fanout ran; transient → unattempted; success → all six writes in one tx — assert via mock tx capture; double-attempt idempotence: second attempt sees state ≠ unattempted → no-op; expired intent → human path). Commit: `feat(api): attemptPolicyDecision — policy-satisfied supervised authorization with atomic exposure reservation (#3827)`

---

### Task 3: Policy-evidence release branch + stricter predicate + final kill read

- `intentReleaseWorker` fetch: when no approved human row exists, load the intent's policy columns; `revalidateApprovedIntentForRelease` gains the branch: `decidedVia === 'policy' ∧ policy_decision_state === 'authorized'` → REQUIRE: digest recompute (existing chain), provenance present, key still in `POLICY_DECIDABLE_TIER3` ∧ headlessCompatible (registry drop ⇒ `policy_authorization_revoked` fail, terminal, notify), key still in BOTH the run snapshot's `actAssets.supervisedActionKeys` AND the agent's CURRENT effective policy, flag still on, kill state re-read not killed. Any human-row path untouched. `checkAgentReleaseAuthority` for policy-decided intents: the guardrail disposition must map to an EXACT current authorization (reuse the same key check — 'propose' is NOT sufficient here, unlike human-approved intents; codex finding).
- Final pre-effect kill read: immediately before the `executeTool` dispatch in the release worker, one more `readAiKillState()` → killed ⇒ the Part-A `kill_switch_engaged` pause path.
- [x] TDD: human-approved intents byte-identical (full release suites); policy intents: each evidence failure → correct terminal/pause; the never-synthesize-human-row property (grep-assert no approval_requests insert in the new code). Commit: `feat(api): policy-evidence release branch — supervised intents execute on durable policy proof (#3827)`

---

### Task 4: Act-lane shared accounting + retention

- `revalidateActExecution` reservation step: also inserts an exposure row (`source:'act'`, intent_id NULL) inside a short system context (NOT held across dispatch — #1105) + gains the same fleet-percent check (advisory-lock + floor) BEFORE reserving; exhaustion → the existing `downgrade` path (proposal). Flag-independent? The exposure WRITE is unconditional post-merge (accounting is truth); the fleet CAP enforcement in the act lane activates with the same sub-flag to keep wave-4 behavior unchanged until wave 5 turns on (document).
- `aiUnattendedExposureRetention` worker: daily sweep deleting rows `reserved_at < now() - 48h` (registry + both snapshot lists 106 → 107 + closure verdict).
- [x] TDD: act path writes rows; cap downgrade; retention query; registry losslessness updated. Commit: `feat(api): act-lane exposure accounting + ledger retention (#3827)`

---

### Task 5: Read-path tolerance + UI + prerequisites

- Null-decider audit completion: approvals list/detail routes + web approvals components render `decidedVia === 'policy'` as "Authorized automatically by policy" (never a person; never "approved by agent"); exports already classify the columns (Part A). Grep every `decidedByUserId` consumer and prove each tolerates NULL+policy (the codex B-item).
- Agent form: `supervisedActionKeys` multi-select sourced from the registry (grouped by tool), gated behind the act acknowledgement pattern; 422 surfacing for rejected keys; i18n keys in every locale.
- Activation prerequisite extension: an agent whose mode is `act` with `supervisedActionKeys` non-empty requires the same recipients prerequisite (already enforced) — verify no new gate needed; policy-decide with mode `shadow`: DECISION (locked, conservative): policy-decide requires `mode === 'act'` — a shadow agent never gets policy-authorized intents (its proposals stay human). Enforce in `resolvePolicyDecisionState` (mode from the run's snapshot) + test.
- [x] TDD + web tests + locale parity → commit: `feat(api,web): policy-decision read tolerance, approvals UI, supervisedActionKeys editor (#3827)`

---

### Task 6: Verification + PR

- [x] Full api + shared + web-touched + typecheck + contract suites + envComposeParity + closure/registry snapshots; grep sweeps: no approval_requests insert in policyDecide/release-evidence code; `runHumanFanout` callers = creation + `runDeferredHumanFanout` only; flag-off inertness proof = full intentService suite + one explicit flag-off e2e test.
- [ ] Tick checkboxes. **Open the PR**: `feature/3821-ai-agents/wave-3827-b` → main, `Closes #3827`, body: locked decisions table, the dark-ship statement, the act-lane cap activation note, rollout guidance (flag on → operator authorizes keys per agent → caps observable in the ledger), follow-ups (admin kill-state surface, per-lane kill-cache isolation, registry growth quorum process). **Stop after opening the PR.**

## Self-Review Notes

- Safety: policy-decide reachable only via flag ∧ agent-originated ∧ supervised ∧ act-mode ∧ registry ∧ per-agent authorization ∧ live guardrails ∧ kill ∧ caps — eight independent gates, each with a failure test; the human decide path and four_eyes/T4/secrets untouched (do-not-touch greps in Task 6).
- At-least-once: post-commit attempt + outbox redelivery both funnel through the state CAS — double-authorize impossible (`unattempted → authorized` single transition), double-fanout impossible (`unattempted → human_required` single transition).
- Type consistency: `runDeferredHumanFanout` (T2) reuses Part A's extraction; provenance digest helper shared by T2 (write) and T3 (verify); exposure insert shape shared by T2/T4.
