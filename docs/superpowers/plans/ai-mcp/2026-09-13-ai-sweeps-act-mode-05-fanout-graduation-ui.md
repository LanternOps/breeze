---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (register after Gate B)
branch: feature/<parent>-ai-sweeps-act-mode/wave-<sub-issue>
---

# AI sweeps act mode — W05: fan-out, budget, graduation, visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound how far one sweep occurrence can reach (a deterministic canary prefix under a new per-occurrence device cap and the real exposure-ledger arithmetic), require sweep-specific verified evidence before a key can graduate, and make the run-detail page show what actually happened rather than only what is still pending.

**Architecture:** Two new `AiAgentLimits` fields — `maxUnattendedDevicesPerSweep` (default 3, merged with the default `min`) and `sweepPromoteThreshold` (default 10, added to `MAX_MERGED_LIMIT_KEYS`) — bump the policy snapshot to v11. `persistSweepFindings` computes a **readiness cohort**, not a reservation: it orders act-eligible proposals deterministically, walks them accumulating distinct devices, and stops at the first that would breach the set-union fleet cap, the per-day action cap, or the new per-occurrence device cap; cohort members are minted act-eligible and **every other proposal is minted exactly as today**. Each intent's own `attemptPolicyDecision` still performs the single, idempotent reservation. `graduationService.ts` gains a `sweepVerified` counter over `ai_agent_op_evidence` joined back to sweep provenance, and a `below_sweep_threshold` rung. `RunDetailPage.tsx` stops relying on `run.intentIds` (pending-only) and reads every intent the run minted.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16 (advisory locks, set-union window queries), zod in `packages/shared`, React + i18next across 8 locales, Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §3.5, §3.7, §3.1's UI cost, OD-2 A, OD-3 A, OD-5 A. Gate A approved.

**Tracking:** issue #4442. Hub: `docs/superpowers/plans/ai-mcp/2026-09-13-ai-sweeps-act-mode.md`. **Depends on W04** (and transitively W01 + W02). No migration.

## Global Constraints

- **No migration in this wave.** Both new limits live in the policy jsonb; the graduation counter is a query. If you reach for DDL, check first whether an index would do — and if it would, add it as its own tiny file in the `1815xx` block rather than reopening a shipped one.
- **No pre-reservation.** The first spec draft reserved M exposure rows at fan-out under a new `source: 'sweep_fanout'`; the quorum proved it breaks the authorize path and it is **rejected** (spec §3.5, review-log 5, **verified**): `sweep_fanout` rows would be excluded from the day count, which filters `source = 'policy_intent'` (`exposureBudget.ts:98-106`); `runAuthorizeTransaction` would insert its own reservation anyway and attach *that* id (`policyDecide.ts:337-347`); and its rollback cannot undo a prior transaction's rows. **The cohort is a readiness check only.**
- **Get the exposure arithmetic right — it is not a running sum** (`exposureBudget.ts:84-108`, **verified**). The fleet cap compares `|existing ∪ candidate|` against `floor(contractDeviceCount * maxFleetPercentPerDay / 100)` with **no `max(1, ·)`** — a fleet too small for one whole device's allowance gets **zero**, and that is the locked quorum decision, not a bug to round away. The day cap counts `source = 'policy_intent'` **rows** per `(org, agent)` in the trailing 24 h, i.e. **actions**: two intents on one device consume **one** device slot but **two** day slots.
- **Deterministic prefix, never iteration order** (OD-2 A). The order is `(severity desc, kind asc, deviceId asc, subjectKey asc)` and it is documented in the code, tested directly, and stable across re-runs. All-or-nothing was rejected on starvation: a 40-device fleet at the 5 % default permits 2 devices, so an org with 3 persistent eligible targets would never act, silently and forever.
- **Nothing is dropped.** A proposal outside the cohort is minted as an ordinary supervised card — exactly today's behaviour. The cohort decides *act-eligibility*, not *existence*.
- **Do not promise atomic cohort execution.** A member can still lose the authorize race or fail decide-time revalidation and degrade to `human_required` on its own. Say so in the code comment and in the UI copy.
- `AI_AGENT_EVIDENCE_SOURCE_KINDS` is **not** extended (spec §3.7, review-log 8). The sweep counter joins to provenance instead.
- Every task: red test first, then `pnpm --filter @breeze/api exec tsc --noEmit`, targeted tests, one commit.

---

### Task 1: Two limits, snapshot v11

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts` (`AiAgentLimits` at `:33`, `AI_AGENT_LIMIT_DEFAULTS` at `:147`, `AI_AGENT_POLICY_SNAPSHOT_VERSION` at `:472`, `AiAgentPolicySnapshot.schemaVersion` at `:475`)
- Modify: `packages/shared/src/validators/aiAgents.ts` (`aiAgentLimitsSchema`)
- Modify: `apps/api/src/services/aiAgents/effectivePolicy.ts` (`MAX_MERGED_LIMIT_KEYS` at `:79`)
- Modify: `apps/api/src/services/aiAgents/runService.ts` (the limits-coverage inventory comment — every limit must name its enforcer)
- Test: `packages/shared/src/validators/aiAgents.test.ts` (existing), `apps/api/src/services/aiAgents/effectivePolicy.test.ts` (existing)

**Interfaces:**
- Produces:
```ts
  /**
   * #4442 W05 — hard per-OCCURRENCE cap on how many distinct devices one
   * sweep may touch unattended. Merged with `min` (the default), so an org
   * may tighten it and never widen it. Default 3: a genuine canary, not a
   * budget — a partner must deliberately raise it. Deliberately NOT reusing
   * `maxActionsPerRun` (also 3), which governs how many CARDS a sweep may
   * raise; conflating "how many approvals" with "how many machines may it
   * touch unattended" is exactly the distinction #4442 is about (OD-3).
   */
  maxUnattendedDevicesPerSweep: number;   // default 3, range 1-50
  /**
   * #4442 W05 — verified-evidence count from SWEEP-MINTED intents a colon key
   * must reach before act mode graduates for a (org, op) pair, ON TOP OF
   * `promoteThreshold`. Merged with `max`, like `promoteThreshold`: a bar, not
   * a budget. Verified evidence from alert-triggered, run-bound intents shows
   * the OP is safe; it says nothing about whether the sweep picked the right
   * TARGET, and target selection is the entire new risk surface (OD-5).
   */
  sweepPromoteThreshold: number;          // default 10, range 1-200
```

- [ ] **Step 1 (RED): failing tests**

```ts
it('maxUnattendedDevicesPerSweep defaults to 3 and clamps to [1,50]', …);
it('sweepPromoteThreshold defaults to 10 and clamps to [1,200]', …);
it('maxUnattendedDevicesPerSweep merges with MIN — org 1 vs partner 5 -> 1; org 9 vs partner 3 -> 3', …);
it('sweepPromoteThreshold merges with MAX — org 5 vs partner 25 -> 25 (an org cannot lower the bar)', …);
it('a v10 snapshot reads back with both fields falling to AI_AGENT_LIMIT_DEFAULTS', …);
```

- [ ] **Step 2: run to verify they fail.** `cd packages/shared && npx vitest run src/validators/aiAgents.test.ts` and `cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy`.

- [ ] **Step 3: implement.** Add both fields with the docstrings above, both defaults, both zod ranges. Add **only** `sweepPromoteThreshold` to `MAX_MERGED_LIMIT_KEYS` — `maxUnattendedDevicesPerSweep` wants the default `min` and adding it would be a real safety inversion. Bump `AI_AGENT_POLICY_SNAPSHOT_VERSION` to `11`, widen `schemaVersion` to `… | 11`, and extend its inline history comment: *"10 (pre-sweep-act-limits), or 11 (current). Read sites must tolerate all eleven."* Every read site already defaults through `AI_AGENT_LIMIT_DEFAULTS`, which is what makes an in-flight v10 snapshot safe — assert it rather than assume it (test 5 above).

Update `runService.ts`'s limits-coverage inventory: `maxUnattendedDevicesPerSweep` is enforced in `persistSweepFindings`' cohort walk (Task 2), `sweepPromoteThreshold` in `graduationService.evaluateEligibility` (Task 3).

- [ ] **Step 4: run + tsc, commit**

```bash
cd packages/shared && npx vitest run src/validators/aiAgents.test.ts && cd -
cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy src/services/aiAgents/runService && cd -
pnpm --filter @breeze/shared exec tsc --noEmit && pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): maxUnattendedDevicesPerSweep and sweepPromoteThreshold limits, snapshot v11 (#4442)"
```

---

### Task 2: The deterministic canary cohort

**Files:**
- Create: `apps/api/src/services/aiAgents/sweepActCohort.ts`
- Create: `apps/api/src/services/aiAgents/sweepActCohort.test.ts`
- Modify: `apps/api/src/services/aiAgents/sweepFindings.ts` (between the existing gates and the `createActionIntent` loop)

**Interfaces:**
- Produces:
```ts
export interface CohortCandidate {
  findingIndex: number; deviceId: string;
  severity: AiSweepSeverity; kind: AiSweepKind; subjectKey: string;
}
/** PURE. The documented order — (severity desc, kind asc, deviceId asc,
 *  subjectKey asc) — never iteration order, never the model's array order. */
export function orderCohortCandidates(c: readonly CohortCandidate[]): CohortCandidate[];
/** PURE. Walks the ordered list accumulating DISTINCT devices and stops at the
 *  first candidate that would breach any of the three caps. Returns the
 *  admitted prefix; everything after it is minted as an ordinary card. */
export function selectCohort(args: {
  ordered: readonly CohortCandidate[];
  existingExposedDevices: ReadonlySet<string>;   // the 24h window, from computeExposureBudget
  allowance: number;                             // floor(contractDevices * pct / 100), no max(1,·)
  policyDecisionsToday: number;
  maxPolicyDecisionsPerDay: number;
  maxUnattendedDevicesPerSweep: number;
}): { admitted: CohortCandidate[]; stoppedBy: 'fleet_cap' | 'day_cap' | 'occurrence_cap' | null };
```

- [ ] **Step 1 (RED): failing pure tests.** These are the arithmetic the quorum corrected, so test the corrections explicitly:

```ts
it('orders by severity desc, then kind asc, then deviceId asc, then subjectKey asc — and is stable across shuffles', …);
it('two candidates on the SAME device consume one device slot but two day slots', () => {
  // allowance 1, maxPolicyDecisionsPerDay 1 -> only ONE admitted (day cap), not two.
});
it('the fleet cap is a SET UNION with the existing window, not existingCount + N', () => {
  // existing {d1,d2}, allowance 2, candidates on d1 and d3 ->
  // d1 admitted (already in the set, union stays 2), d3 stops it (union would be 3).
});
it('allowance 0 (a fleet too small for one whole device) admits NOTHING — no max(1, .)', …);
it('the per-occurrence cap stops the walk even when both ledger caps have room', …);
it('reports which cap stopped it, so the run detail can say why', …);
it('an empty candidate list returns an empty cohort and stoppedBy null', …);
```

- [ ] **Step 2: run to verify they fail.** `cd apps/api && npx vitest run src/services/aiAgents/sweepActCohort.test.ts`.

- [ ] **Step 3: implement the pure module**, then wire it in `persistSweepFindings`. The wiring runs **once per occurrence**, after the existing gates 1–4 and before the mint loop, and reads the ledger through the shared `computeExposureBudget` — never a second copy of the queries:

```ts
  // #4442 §3.5 — the READINESS cohort. Deliberately NOT a reservation: see the
  // plan's Global Constraints (a sweep_fanout exposure row would be excluded
  // from the day count, runAuthorizeTransaction would insert its own anyway,
  // and its rollback cannot undo a prior transaction). Each intent's own
  // attemptPolicyDecision performs the single, idempotent reservation exactly
  // as today; this walk only bounds over-subscription.
  //
  // Read-only, but under the SAME per-org advisory lock the authorize path
  // takes, so the snapshot this walk sees cannot be split by a concurrent
  // authorization mid-occurrence.
  //
  // A cohort member can STILL individually lose the authorize race or fail
  // decide-time revalidation and degrade to human_required. This is a bound,
  // not a promise of atomic execution.
```

Take the lock with the identical key the authorize path uses — `pg_advisory_xact_lock(hashtextextended('ai-exposure:' || orgId, 0))` (`policyDecide.ts:296`) — inside a short read-only system transaction, and release it by ending that transaction **before** the mint loop starts. Do **not** hold it across `createActionIntent`: that function opens its own transaction via `runOutsideDbContext`, and holding a pooled connection across N of those is the double-hold hang the CLAUDE.md partner-wide section warns about.

Cohort membership is expressed by passing `sweepAct` (W04's `SweepActEligibility`) **only for admitted candidates**; a non-member simply gets no `sweepAct` and `resolvePolicyDecisionState` returns `human_required` through the gate that already exists. Record `cohort: true | false` and `stoppedBy` on the `SweepProposalRecord` so the UI can explain itself.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/sweepActCohort src/services/aiAgents/sweepFindings src/services/actionIntents/exposureBudget
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): deterministic canary cohort bounds unattended sweep fan-out (#4442)"
```

---

### Task 3: The sweep-lane graduation gate

**Files:**
- Modify: `apps/api/src/services/aiAgents/graduationService.ts` (`WINDOW_SELECT` at `:198`, `toWindow` at `:221`, `EligibilityInput` at `:235`, `firstBlockedReason` at `:281`, the context loader at `:380`)
- Modify: `packages/shared/src/types/aiAgentGraduation.ts` (`AI_AGENT_GRADUATION_BLOCKED_REASONS` at `:43`, `AiAgentGraduationWindow`)
- Modify: `apps/web/src/components/aiAgents/AiAgentGraduationPanel.tsx` + 8 locales
- Test: `apps/api/src/services/aiAgents/graduationService.test.ts` (existing)

**Interfaces:**
- Produces: `AiAgentGraduationWindow.sweepVerified: number`; blocked reason `'below_sweep_threshold'`; `EligibilityInput.sweepPromoteThreshold: number`.

- [ ] **Step 1 (RED): failing tests**

```ts
it('a key at promoteThreshold but with sweepVerified below sweepPromoteThreshold blocks with below_sweep_threshold', …);
it('the reason ORDER is preserved: not_policy_decidable > needs_partner_baseline > has_failures > below_threshold > below_sweep_threshold > too_recent', …);
it('sweepVerified counts a WATCH-sourced verified row whose watch is subject-anchored (W02)', …);
it('sweepVerified counts an INTENT-sourced verified row whose intent is trigger_kind sweep_finding', …);
it('sweepVerified does NOT count an alert-triggered verified row', …);
it('a malformed source_id cannot crash the query (the ::uuid cast is shape-guarded)', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement the counter.** The join needs **two arms**, and this is the spec correction that matters most here. `intentEvidenceSourceId(intentId)` returns the bare intent id, but a watch row's source id is `` `${watchId}:${opKey}` `` (`opEvidence.ts:129`, `:137`, **verified**) — and after W02 the sweep lane's `verified` rows are *watch* rows written by `recordWatchVerdictEvidence` (`fixWatch.ts:544-561`), not intent rows. A single-arm join would count zero and block every sweep key forever.

```sql
COUNT(*) FILTER (WHERE e.metric = 'verified' AND (
  -- arm A: the intent row itself
  (e.source_kind = 'intent'
     AND e.source_id ~ '^[0-9a-fA-F-]{36}$'
     AND EXISTS (SELECT 1 FROM action_intents i
                  WHERE i.id = e.source_id::uuid
                    AND i.org_id = e.org_id
                    AND i.trigger_kind = 'sweep_finding'))
  -- arm B: the subject watch that graded it (W02)
  OR (e.source_kind = 'watch'
     AND split_part(e.source_id, ':', 1) ~ '^[0-9a-fA-F-]{36}$'
     AND EXISTS (SELECT 1 FROM ai_agent_fix_watches w
                  WHERE w.id = split_part(e.source_id, ':', 1)::uuid
                    AND w.org_id = e.org_id
                    AND w.subject_kind IS NOT NULL))
))::int AS sweep_verified
```

The two regex guards are load-bearing, not defensive style: an unguarded `::uuid` cast over a malformed `source_id` raises `22P02` and takes the whole graduation sweep down. Both `EXISTS` sub-selects pin `org_id` on both sides — the ladder runs from a system-scoped worker, so the predicate is the isolation boundary.

Add the rung to `firstBlockedReason` **after** `below_threshold` and **before** `too_recent`, so an operator who has not met either bar is told about the ordinary one first:

```ts
  if (window.verified < promoteThreshold) return 'below_threshold';
  if (window.sweepVerified < sweepPromoteThreshold) return 'below_sweep_threshold';
```

Load `sweepPromoteThreshold` from the merged effective policy alongside `promoteThreshold` (`graduationService.ts:386-387`), with the same `?? AI_AGENT_LIMIT_DEFAULTS.…` fallback.

- [ ] **Step 4: surface it.** Add `below_sweep_threshold` to the panel's reason map and to all 8 `settings.json` locales, with copy that says what it means — *"needs N verified fixes that a scheduled sweep chose the target for"* — not just a restated enum name.

- [ ] **Step 5: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/graduationService && cd -
cd apps/web && npx vitest run src/components/aiAgents/AiAgentGraduationPanel src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts && cd -
pnpm --filter @breeze/shared exec tsc --noEmit && pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): sweep-lane graduation gate — sweepPromoteThreshold over sweep-minted verified evidence (#4442)"
```

---

### Task 4: Run detail — per-intent outcomes and a per-device roll-up

**Files:**
- Modify: `apps/api/src/routes/aiAgents.ts` (the run-detail intent read at `:1306-1320`)
- Modify: `packages/shared/src/types/aiAgentRuns.ts` (`AiAgentRunSweepFindingDto.proposal`)
- Modify: `apps/api/src/services/aiAgents/sweepFindings.ts` (`projectSweep`)
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx` (`SweepProposalContent` at `:773-805`)
- Modify: `apps/web/src/locales/*/settings.json`
- Test: `apps/api/src/routes/aiAgents.test.ts` (existing), `apps/web/src/components/aiAgents/RunDetailPage.test.tsx` (existing)

**Interfaces:**
- Produces: `proposal.outcome: 'pending' | 'auto_executing' | 'executed' | 'failed' | 'declined' | 'expired' | null`, `proposal.cohort: boolean`, `proposal.stoppedBy: string | null`, and a run-level `sweep.actSummary: { devicesActed: number; devicesProposed: number; stoppedBy: string | null }`.

- [ ] **Step 1 (RED): failing tests**

```ts
// routes/aiAgents.test.ts
it('the run detail reports a COMPLETED sweep intent — run.intentIds is pending-only and would have dropped it', async () => {
  // The exact regression act mode introduces: the interesting outcomes are
  // no longer pending.
});
it('reads intents by requesting_agent_run_id, org-pinned, not by run.intentIds', …);

// RunDetailPage.test.tsx
it('an auto-executed proposal renders the outcome, not a generic /approvals link', …);
it('a proposal outside the canary cohort renders "waiting for approval" and names the cap that stopped it', …);
it('a pre-act-mode run (no cohort field) still renders exactly as before', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement the API half.** `run.intentIds` only ever lists **pending** intents (the column docstring and `routes/aiAgents.ts:1307-1311`, **verified**) — an intent that was decided or expired drops out of the array. Act mode makes the interesting outcomes non-pending, so the read must change to `WHERE requesting_agent_run_id = $runId AND org_id = $orgId`, keeping the org predicate as defence-in-depth beside RLS. Select `id, status, actionName, approvalScope, decidedVia, errorCode, executedAt` and map to the new `outcome`, with `decidedVia === 'policy' && status === 'approved'` → `auto_executing`. Keep `run.intentIds` populated as-is for every other consumer; this route just stops depending on it.

`projectSweep` joins the outcome onto the finding by `intentId`, and carries `cohort` / `stoppedBy` through from the record. Keep the leak posture unchanged: display fields only, never the raw `proposedAction`, and re-run the `AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS` assertions.

- [ ] **Step 4: implement the web half.** Replace the unconditional `/approvals` link with a per-outcome renderer, and add the per-device roll-up above the findings table: *"Acted unattended on 2 of 5 devices — the rest are waiting for approval (per-sweep device cap)."* Copy must not imply the cohort executes atomically; a member can still degrade on its own.

- [ ] **Step 5: 8 locales, run, commit**

```bash
cd apps/api && npx vitest run src/routes/aiAgents src/services/aiAgents/sweepFindings && cd -
cd apps/web && npx vitest run src/components/aiAgents/RunDetailPage src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts && cd -
pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit
git commit -m "feat(web): per-intent outcomes and act roll-up on the sweep run detail (#4442)"
```

---

### Task 5: Live-DB fan-out and budget contracts

**Files:**
- Create: `apps/api/src/__tests__/integration/sweepActFanout.integration.test.ts`

- [ ] **Step 1 (RED): write the four cases the spec names, against real Postgres**

```ts
it('an occurrence proposing more devices than the allowance mints exactly the cohort act-eligible and the remainder as cards — and drops nothing', …);
it('a SECOND occurrence in the same 24h window sees the UNION, not a fresh budget', async () => {
  // Occurrence 1 acts on d1,d2. Occurrence 2 proposing d1,d3 with allowance 2:
  // d1 is already in the window (union stays 2) so it may act; d3 may not.
});
it('two intents on ONE device consume one device slot and two DAY slots', …);
it('an auto-demote from a sweep-minted ATTEMPTED failure revokes the key, and the NEXT occurrence produces cards', …);
it('the deterministic order is reproducible: the same evidence set yields the same cohort across two runs', …);
```

- [ ] **Step 2: run.** `pnpm test-stack up && pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepActFanout.integration.test.ts`.

- [ ] **Step 3: commit**

```bash
git commit -m "test(ai): live-DB sweep fan-out, exposure union and auto-halt contracts (#4442)"
```

---

### Task 6: Full suite, rollout note, PR

- [ ] **Step 1: run every live-DB suite this feature can redden**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepActFanout.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepActOpKeyIntersection.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepIntentVerification.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/web test --run
pnpm test-stack down
```

- [ ] **Step 2: write the rollout runbook into the PR body** (spec §10). Not a doc file — the PR is where a reviewer will look:

> 1. Deploy with `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` **unset** (off). Everything above ships dark.
> 2. Pick one internal partner. Arm `act_mode` on **one** sweep baseline; leave every other org's override disarmed.
> 3. Set `maxUnattendedDevicesPerSweep = 1` on that partner — one device per occurrence, not three.
> 4. Confirm the org row grants exactly `manage_services:restart` and the partner baseline lists it too (the intersection is the grant).
> 5. Turn the flag on. Read the graduation panel for **two weeks** before widening: `sweepVerified` should climb and `recurred`/`failed` should stay at zero. Any `recurred` auto-demotes the key and the lane returns to cards on its own — that is the system working, not an incident.
> 6. Widen by raising `maxUnattendedDevicesPerSweep`, one step at a time. Do **not** widen by adding op keys; `remediate_vulnerability` is explicitly out of scope and needs its own effect-pin review.

- [ ] **Step 3: open the PR.** Body must also state: OD-2 A (deterministic prefix, with the starvation arithmetic that killed all-or-nothing) and OD-3 A (default 3, `min`-merged, and why not `maxActionsPerRun`); that pre-reservation was rejected and the cohort is a readiness check; the corrected exposure arithmetic (set union for devices, row count for the day cap, no `max(1, ·)`); the two-arm graduation join and why a single arm would count zero; and that the run-detail route no longer depends on the pending-only `run.intentIds`. `Closes #<wave sub-issue>`, `Closes #4442`. If stacked, `gh workflow run CI --ref <branch>`.
