---
tracking_issue: LanternOps/breeze#5751
wave_issue: LanternOps/breeze#5755
branch: feature/5751-ai-sweeps-act-mode/wave-5755
---

# AI sweeps act mode — W04: the act gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `resolvePolicyDecisionState`'s blanket `if (args.hasScope) return 'human_required'` with a narrow, five-condition allowance so a sweep-minted intent can reach the policy-decide lane — with a trusted, system-authored subject as the anti-substitution control, a live condition re-probe at decide time, and a schedule brake that is re-checked at release.

**Architecture:** The execution unit is the **device-scoped intent**, not a child `ai_agent_runs` row (OD-1 A) — everything a child run was invented to carry already exists on the intent, and a second run row would duplicate budget, circuit and trace accounting for a step that spends no tokens. `ai_agent_schedules` gains a nullable `act_mode`, tighten-only through the existing `effectiveSchedule` merge. `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` sits **on top of** `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`, so the sweep lane is revocable without disarming the alert-triggered one. `persistSweepFindings` matches each proposal against the SYSTEM's own evidence row and writes a trusted `subject` onto `SweepProposalRecord`; the gate splits across the two moments that already exist — **creation** (`resolvePolicyDecisionState`: flags, trigger kind, schedule armed, trusted subject present and matching the arguments) and **decide time** (`attemptPolicyDecision`: freshness, `sweepSubjectProbe`, and every gate policy-decide already runs). Release adds one more: `revalidateApprovedIntentForRelease` re-reads the schedule, because a creation-time gate cannot revoke an intent already authorized.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16, zod in `packages/shared`, React + i18next across 8 locales, Vitest (unit with Drizzle mocks; integration against real Postgres).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §3.1–§3.4, §3.6, OD-1 A. Gate A approved.

**Tracking:** issue #4442 (anchor). Hub: `docs/superpowers/plans/ai-mcp/2026-09-13-ai-sweeps-act-mode.md`. **Hard prerequisites: W01 merged** (`action_intents.trigger_kind`) **and W02 merged** (without it, every act-mode execution is credited `verified` unconditionally and the graduation ladder becomes a click-counter — spec §1.1). Do not start this wave otherwise.

## Global Constraints

- Migration filename `apps/api/migrations/2026-10-16-191900-ai-agent-schedules-act-mode.sql` (the `1815xx` slot this plan reserved was overtaken on main; 190900 is the first free slot after the newest committed migration). Re-check `ls apps/api/migrations | sort | tail -1` against `origin/main`; bump upward only; never rename for today's date.
- **Pure DDL, no DML** — see the `act_mode` nullability decision below, which is what makes a backfill unnecessary. `migrationRlsScope.test.ts` stays green with no elevation.
- **`act_mode` is nullable, three-valued, on both arms.** `NOT NULL DEFAULT false` would be a trap: every existing org override row would materialise as `false`, and `effectiveSchedule`'s `baseline && (override ?? true)` shape would then make a partner-wide arming invisible to precisely the orgs that have an override. Semantics instead: **on a baseline, `true` = armed and anything else = not armed; on an override, `false` = explicitly disarmed and anything else = inherit.** Effective is `baseline.actMode === true && override?.actMode !== false`. Fail-closed in both directions, no backfill, no CHECK.
- **Flag-off must be byte-identical to today.** With `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED` false, `resolvePolicyDecisionState` returns `'human_required'` for every scoped intent, evaluating nothing else — the same property P2-5 asserted for its own flag, and the cheapest possible regression test. Task 3 Step 1 writes it before anything else changes.
- **Every unresolved condition fails closed to `human_required`**, matching every other branch in that function. There is no "probably fine" path.
- **Op-key reality check:** of the two members of the closed `SweepProposedAction` union, only `manage_services:restart` is in `POLICY_DECIDABLE_TIER3` (`apps/api/src/services/actionIntents/policyDecidableKeys.ts:79-175`, **verified** — `remediate_vulnerability` is absent). **Act mode for sweeps v1 covers exactly one op key.** Say so in the UI (Task 9); do not let an operator discover it.
- **No child `ai_agent_runs` row** (OD-1 A). If you find yourself creating one, stop.
- **No new `action_intents` status.** There is no `superseded` and we are not adding one (`schema/actionIntents.ts:50`). A cleared or unknown condition calls `degradeToHumanRequired`, which turns the intent into an ordinary supervised card.
- Registration lists: no new tables. One new `included` column on `ai_agent_schedules` in `CORE_TENANT_EXPORT_POLICY`.
- Every task: red test first, then `pnpm --filter @breeze/api exec tsc --noEmit`, targeted tests, one commit.

---

### Task 1: Migration — `act_mode` + export-policy registration

**Files:**
- Create: `apps/api/migrations/2026-10-16-181520-ai-agent-schedules-act-mode.sql`
- Modify: `apps/api/src/db/schema/aiAgentSchedules.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`ai_agent_schedules` entry)
- Test: `apps/api/src/db/schema/aiAgentSchedules.test.ts` (existing), `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`

**Interfaces produced:** `ai_agent_schedules.act_mode boolean NULL`.

- [ ] **Step 1: write the migration**

```sql
-- Sweep act mode (#4442 W04) — spec §3.2 condition 3.
--
-- Deliberately NULLABLE and three-valued rather than NOT NULL DEFAULT false.
-- A false default would materialise on every EXISTING org override row, and
-- effectiveSchedule's `baseline && (override ?? true)` shape would then make a
-- partner-wide arming invisible to exactly the orgs that have an override —
-- silently, with no error. Semantics:
--   baseline:  true = armed;      anything else = not armed
--   override:  false = disarmed;  anything else = inherit
-- effective = baseline.act_mode IS TRUE AND override.act_mode IS DISTINCT FROM false
-- Fail-closed in both directions, so there is nothing to backfill and this
-- file carries no DML.
--
-- The one-owner CHECK, the dual-axis RLS policy and the partner-wide SELECT
-- branch on this table are unchanged (2026-09-23-ai-agents-scheduled-sweeps.sql).
ALTER TABLE ai_agent_schedules ADD COLUMN IF NOT EXISTS act_mode boolean;
```

- [ ] **Step 2 (RED): export-policy unit guard.** Same pattern as W01/W03: assert `ai_agent_schedules.act_mode` is `included` in `CORE_TENANT_EXPORT_POLICY` so the miss reds in **Test API**, not two jobs later. Run, watch it fail.

- [ ] **Step 3: implement.** `actMode: boolean('act_mode')` on `aiAgentSchedules` with the three-valued docstring; `"act_mode"` appended to the entry's `included` array.

- [ ] **Step 4: apply, verify, commit**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run src/db/schema/aiAgentSchedules.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
git commit -m "feat(db): act_mode on ai_agent_schedules, tighten-only and three-valued (#4442)"
```

---

### Task 2: `actMode` through the schedule contract — DTO, merge, routes

**Files:**
- Modify: `packages/shared/src/types/aiAgentSchedules.ts` (`AiAgentScheduleDto`, `AiAgentEffectiveScheduleDto.effective`/`.override`)
- Modify: `packages/shared/src/validators/aiAgentSchedules.ts` (create + update schemas)
- Modify: `apps/api/src/services/aiAgents/scheduleService.ts` (`effectiveSchedule` at `:88`, `overrideSummary` at `:217`, `toScheduleDto` at `:195`)
- Modify: `apps/api/src/routes/aiAgentSchedules.ts` (POST `:134`, PATCH `:169`)
- Test: `apps/api/src/services/aiAgents/scheduleService.test.ts` (existing), `apps/api/src/routes/aiAgentSchedules.test.ts` (existing)

**Interfaces:**
- Produces: `AiAgentScheduleDto.actMode: boolean | null`; `AiAgentEffectiveScheduleDto.effective.actMode: boolean`; `ScheduleOverrideSummary.actMode: boolean | null`.
- Produces: `effectiveSchedule(baseline, override)` returns `actMode: baseline.actMode === true && override?.actMode !== false`.

- [ ] **Step 1 (RED): failing tests — the truth table is the test**

```ts
describe('effectiveSchedule actMode (tighten-only)', () => {
  const cases: Array<[boolean | null, boolean | null | undefined, boolean]> = [
    [true,  undefined, true],   // partner armed, no override
    [true,  null,      true],   // partner armed, override says nothing -> inherit
    [true,  true,      true],   // partner armed, override agrees
    [true,  false,     false],  // partner armed, ORG DISARMS  <- the brake
    [false, true,      false],  // ORG CANNOT ARM what the partner did not
    [null,  true,      false],  // ditto, unset baseline
    [null,  undefined, false],
  ];
  it.each(cases)('baseline=%s override=%s -> %s', (b, o, want) => { … });
});
it('an ORG-scoped caller cannot PATCH act_mode to true on its override (403 / stripped)', …);
it('a PARTNER caller arming act_mode is gated on canManagePartnerWidePolicies', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** Add `actMode` to `effectiveSchedule`, `overrideSummary` and both DTO shapes. On the create/update zod schemas, `actMode: z.boolean().nullish()`. Route rules:
  - **Partner arm** (`actMode: true` on a partner baseline) is a partner-wide policy write → gate on `canManagePartnerWidePolicies(auth)` (`apps/api/src/services/partnerWideAccess.ts`, the single source of truth), same as every other partner-wide field on this router.
  - **Org override** may set `actMode: false` or `null` only. `true` from an org-scoped caller is rejected — do not silently coerce; a caller that thinks it armed something and did not is worse than a 403.
  - `toScheduleDto` returns the raw column so the UI can distinguish "inherit" from "explicitly off".

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/scheduleService src/routes/aiAgentSchedules
cd ../.. && pnpm --filter @breeze/shared exec tsc --noEmit && pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): actMode on the schedule contract, tighten-only through effectiveSchedule (#4442)"
```

---

### Task 3: The flag, and the flag-off regression control

**Files:**
- Modify: `apps/api/src/config/env.ts` (beside `policyDecideEnabled()` at `:112`)
- Create: `apps/api/src/services/actionIntents/policyDecide.sweepFlagOff.test.ts`

**Interfaces:**
- Produces: `export function sweepActEnabled(): boolean` — `envFlag('BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED', false)`, read at **call** time (not a module constant) so a test can flip it per case without `vi.resetModules()`, exactly like `policyDecideEnabled()`.

- [ ] **Step 1 (RED): write the control FIRST, before any gate change.** This test must pass on `origin/main` today, keep passing through every later task in this wave, and be the thing that catches a gate leaking out from behind the flag:

```ts
describe('BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED=false is byte-identical to today', () => {
  it.each([
    ['sweep-minted, schedule armed, subject present', sweepIntentArgs()],
    ['sweep-minted, schedule NOT armed', …],
    ['ticket-scoped', …],
    ['device-scoped from a non-sweep caller', …],
  ])('%s -> human_required', (_n, args) => {
    process.env.BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED = 'false';
    expect(resolvePolicyDecisionStateForTest(args)).toBe('human_required');
  });
  it('does not read the schedule, the subject or the probe when the flag is off', () => {
    // assert the injected loaders were never called — a gate that queries
    // before it checks the flag is a behaviour change even when the verdict
    // is the same.
  });
});
```

`resolvePolicyDecisionState` is module-private today. Export it as `@internal` (or export a thin `__resolvePolicyDecisionStateForTest`) rather than testing it only through `createActionIntent` — the eight-gate ladder deserves a direct unit surface, and every later task in this wave adds cases to it.

- [ ] **Step 2: run it green on the current code.** `cd apps/api && npx vitest run src/services/actionIntents/policyDecide.sweepFlagOff.test.ts`. It should pass immediately (nothing has changed yet). That is the point: it is the invariant, not a red.

- [ ] **Step 3: add `sweepActEnabled()`** with a docstring naming the two-flag rationale (spec §3.2 condition 1): the sweep lane widens autonomy to targets the run never established for itself, so it must be revocable without disarming alert-triggered policy-decide.

- [ ] **Step 4: commit**

```bash
git commit -m "feat(api): BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED sub-flag + flag-off regression control (#4442)"
```

---

### Task 4: The trusted subject on `SweepProposalRecord`

**Files:**
- Modify: `apps/api/src/services/aiAgents/sweepEvidence.ts` (export a per-kind subject extractor over `SweepEvidenceRow`)
- Modify: `apps/api/src/services/aiAgents/sweepFindings.ts` (`SweepProposalRecord`, `SweepPersistRunInput`, the gate loop)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (`finalizeSweep` — pass the evidence subjects it already holds)
- Test: `apps/api/src/services/aiAgents/sweepEvidence.subjects.test.ts` (create), `apps/api/src/services/aiAgents/sweepFindings.test.ts` (existing)

**Interfaces:**
- Produces (in `sweepEvidence.ts`):
```ts
export interface SweepEvidenceSubject { kind: AiSweepKind; deviceId: string; key: string; observedAt: string; }
/** The SYSTEM's own subject for one loader row — derived from NAMED fields the
 *  loader read off a column, never from model text. Null for a kind with no
 *  single subject. Pure and exhaustively tested per kind. */
export function evidenceRowSubject(kind: AiSweepKind, row: SweepEvidenceRow): SweepEvidenceSubject | null;
/** Every subject in a loaded evidence set, keyed `${kind}|${deviceId}|${key}`. */
export function indexEvidenceSubjects(evidence: SweepEvidence): ReadonlyMap<string, SweepEvidenceSubject>;
```
- Produces (in `sweepFindings.ts`): `SweepProposalRecord.subject?: { kind: AiSweepKind; key: string; observedAt: string }`; `SweepPersistRunInput.evidenceSubjects: ReadonlyMap<string, SweepEvidenceSubject>` (**replaces** `evidenceDeviceIds`, which is derivable from it).

- [ ] **Step 1 (RED): failing tests**

```ts
// sweepEvidence.subjects.test.ts
it('service_down: the subject key is the service NAME from the evidence row, and observedAt is checkedAt', …);
it('disk_pressure: the subject key is the mount point', …);
it('unpatched_critical: the subject key is the SORTED device-vulnerability ids, comma-joined', …);
it('a kind with no single subject returns null', …);
it('indexEvidenceSubjects keys on kind|deviceId|key and drops rows with a null deviceId', …);

// sweepFindings.test.ts
it('attaches the SYSTEM subject to the record when the proposal matches an evidence row', …);
it('refuses a proposal whose serviceName does not match ANY evidence subject for that device — evidence about service A must not authorize a restart of service B', async () => {
  // The anti-substitution control. reason: 'subject_not_in_evidence'.
});
it('a finding-only kind (expiring_certs) proposes nothing, so no subject is required', …);
it('a proposal with no matching subject on a kind that HAS subjects is refused, not silently act-ineligible', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** The spec's key finding here (review-log 2, **verified** at `runLoopTypes.ts:210-217`): the run outcome stores `sweepProposals[]` and `sweepEvidenceTruncated` and its docstring says outright *"the evidence itself is never stored on the run"* — `evidenceDeviceIds` is assembled in memory and discarded. And device identity alone is not enough: a `service_down` observation is about `(device, service name)`.

So `persistSweepFindings` gains a **gate 1b** immediately after the existing `device_not_in_evidence` gate: derive the proposal's subject key with the same per-kind rule (`sweepSubjectKey` from W01 Task 3, which must be re-expressed in terms of `evidenceRowSubject` so build and match cannot drift), look it up in `evidenceSubjects`, and refuse with a new `SweepProposalReason` `'subject_not_in_evidence'` when absent. Write the **system's** subject onto the record, never the model's:

```ts
const subject = run.evidenceSubjects.get(`${finding.kind}|${deviceId}|${proposalSubjectKey(proposal)}`);
if (!subject) { record.reason = 'subject_not_in_evidence'; proposals.push(record); continue; }
record.subject = { kind: subject.kind, key: subject.key, observedAt: subject.observedAt };
```

Add `'subject_not_in_evidence'` to `SweepProposalReason` in `@breeze/shared` and to the web's reason-label map plus 8 locales (`sweepReasonLabel`, `RunDetailPage.tsx:795`).

`SweepProposalRecord` stays **scalars-only** — three strings, no nesting beyond one flat object; it is persisted into the run's `outcome` jsonb, which is already `excludedOpen`, so no registry change.

Keep `run.evidenceDeviceIds` as a derived getter over `evidenceSubjects.values()` if that reduces churn at the call site, but the map is the input.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/sweepEvidence src/services/aiAgents/sweepFindings src/services/aiAgents/runLoop
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): system-authored trusted subject on sweep proposals (#4442)"
```

---

### Task 5: The `hasScope` replacement — creation-time gates

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`resolvePolicyDecisionState` at `:626-682`, its call site at `:1624`, `CreateActionIntentInput`)
- Modify: `apps/api/src/services/aiAgents/sweepFindings.ts` (pass the sweep-act descriptor)
- Test: `apps/api/src/services/actionIntents/intentService.sweepAct.test.ts` (create), plus new cases in `policyDecide.sweepFlagOff.test.ts`

**Interfaces:**
- Produces:
```ts
/** Everything creation knows about a sweep-minted proposal's act eligibility.
 *  Assembled by the CALLER from system state; `resolvePolicyDecisionState`
 *  only reads it, so the gate stays pure and directly unit-testable. */
export interface SweepActEligibility {
  scheduleActMode: boolean;                 // the EFFECTIVE (baseline ∧ override) value
  subject: { kind: AiSweepKind; key: string; observedAt: string };
  argumentsMatchSubject: boolean;
}
// CreateActionIntentInput gains: sweepAct?: SweepActEligibility
```

- [ ] **Step 1 (RED): failing tests — one per gate, each failing closed**

```ts
it.each([
  ['sub-flag off',                     { flags: { sweep: false, decide: true } }],
  ['policy-decide flag off',           { flags: { sweep: true,  decide: false } }],
  ['trigger_kind is not sweep_finding',{ trigger: { kind: 'ticket' } }],           // a ticket scope must NOT inherit this
  ['no trigger at all',                { trigger: undefined }],
  ['schedule not armed',               { sweepAct: { scheduleActMode: false } }],
  ['no trusted subject',               { sweepAct: undefined }],
  ['arguments do not match the subject',{ sweepAct: { argumentsMatchSubject: false } }],
  ['tier < 3',                         { tier: 2 }],
  ['approvalScope four_eyes',          { approvalScope: 'four_eyes' }],
  ['run snapshot mode is shadow',      { agentMode: 'shadow' }],
  ['no agent run',                     { agentRun: null }],
])('%s -> human_required', …);

it('all gates satisfied -> unattempted', …);
it('a device scope from a NON-sweep caller is still human_required — the allowance keys on trigger_kind, not on having a scope', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** Replace the single line with the narrow allowance, preserving the surrounding ladder exactly:

```ts
  if (args.guardrail.tier < 3) return 'human_required';

  // #4442 — the narrow replacement for P2-2's blanket `if (args.hasScope)`.
  // A scoped intent is decidable ONLY when every one of these holds; anything
  // unresolved falls through to human_required, like every other branch here.
  // Keying on trigger_kind and NOT on "has a scope" is load-bearing: a ticket
  // scope, or a scope kind added later, must not inherit this allowance.
  if (args.hasScope) {
    if (!sweepActEnabled()) return 'human_required';
    if (args.triggerKind !== 'sweep_finding') return 'human_required';
    const act = args.sweepAct;
    if (!act) return 'human_required';
    if (!act.scheduleActMode) return 'human_required';
    if (!act.argumentsMatchSubject) return 'human_required';
    // Freshness and the live condition re-probe are DECIDE-time, not here —
    // see attemptPolicyDecision. Creation cannot probe: it runs inside the
    // intent's own transaction and a probe there would hold a pooled
    // connection across a second query for every proposal in the occurrence.
  }

  if (!args.agentRun) return 'human_required';
```

Note the flag order deliberately puts `sweepActEnabled()` first inside the branch so the flag-off control's "reads nothing else" assertion holds.

`argumentsMatchSubject` is computed by the **caller** using the same shape as `assertArgsMatchScope` (`apps/api/src/services/actionIntents/intentTargetScope.ts:198`): for `manage_services:restart`, `input.serviceName === subject.key && input.deviceId === scope.deviceId`. Put that comparison in one exported pure function (`subjectMatchesArguments(subject, toolName, input)`) so the gate and the decide-time re-check cannot drift.

In `sweepFindings.ts`, resolve the **effective** schedule act mode once per occurrence (not per proposal) via `effectiveSchedule(baseline, override)` and pass it down; the run already carries `scheduleId`.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/actionIntents/intentService src/services/actionIntents/policyDecide src/services/aiAgents/sweepFindings
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): sweep-minted intents may reach policy-decide behind five creation-time gates (#4442)"
```

(no trailing slash on those filters — confirm ≥ 8 files ran.)

---

### Task 6: Decide-time — freshness and the live condition re-probe

**Files:**
- Modify: `apps/api/src/services/actionIntents/policyDecide.ts` (`attemptPolicyDecision` at `:447`, `DegradeReason` at `:200-222`)
- Test: `apps/api/src/services/actionIntents/policyDecide.test.ts` (existing)

**Interfaces:**
- Produces: two new `DegradeReason` members, `'sweep_condition_cleared'` and `'sweep_condition_unknown'`, plus `'sweep_intent_stale'`.
- Produces: `export const SWEEP_ACT_TTL_MS = 30 * 60_000;`

- [ ] **Step 1 (RED): failing tests**

```ts
it('probe present -> proceeds to runAuthorizeTransaction', …);
it('probe cleared -> degradeToHumanRequired("sweep_condition_cleared"), NO exposure row, NO evidence row', …);
it('probe unknown -> degradeToHumanRequired("sweep_condition_unknown") — fail closed', …);
it('an intent older than SWEEP_ACT_TTL_MS -> degradeToHumanRequired("sweep_intent_stale") without probing', …);
it('a subject observed longer ago than SWEEP_ACT_TTL_MS -> stale, even if the intent is young', …);
it('a probe that THROWS is transient — the intent is left unattempted and PolicyDecisionTransientError is rethrown, never degraded', …);
it('a NON-sweep intent takes no new branch at all (byte-identical path)', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** Insert the sweep block **after** the existing snapshot-key check and **before** `readAiKillState()`, so it costs nothing for an intent that was going to be refused anyway:

```ts
    // #4442 — sweep-lane freshness + live condition re-evaluation.
    //
    // Freshness anchors on the INTENT and on the SUBJECT's own observedAt,
    // NOT on run.finished_at: a sweep intent is minted inside finalizeSweep,
    // which runs BEFORE finishRun writes finished_at, and this function is
    // reached from createActionIntent's post-commit trigger — so
    // run.finished_at is null at exactly the moment this would read it.
    if (intent.triggerKind === 'sweep_finding') {
      const subject = parseSweepTriggerKey(intent.triggerKey);
      if (!subject || !intent.scopeDeviceId) {
        await degradeToHumanRequired(intentId, 'agent_policy_denied', { reason: 'sweep subject unresolvable' });
        return;
      }
      if (Date.now() - intent.createdAt.getTime() > SWEEP_ACT_TTL_MS) {
        await degradeToHumanRequired(intentId, 'sweep_intent_stale');
        return;
      }
      // Throws propagate: a probe failure is TRANSIENT (retry), never a
      // deterministic refusal. Do not wrap this in a try/catch.
      const verdict = await probeSweepSubject(subject.kind, intent.orgId, intent.scopeDeviceId, subject.key);
      if (verdict === 'cleared') { await degradeToHumanRequired(intentId, 'sweep_condition_cleared'); return; }
      if (verdict === 'unknown') { await degradeToHumanRequired(intentId, 'sweep_condition_unknown'); return; }
    }
```

Three properties to preserve and to state in the comment:
- **A cleared condition writes no evidence row**, so nothing auto-demotes. Recovery is not a failure (spec §3.4).
- `SWEEP_ACT_TTL_MS` is 30 minutes, which is ≤ the schedule's own cadence by construction — `assertValidCron`'s hourly floor (`scheduleService.ts`, `isHourlyFloorCron`) means a sweep fires at most once an hour.
- The probe runs **outside** `runAuthorizeTransaction`'s advisory lock. It is a read; holding the per-org lock across it would serialise every org's authorizations behind a network round trip.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/actionIntents/policyDecide
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): decide-time freshness and condition re-probe for sweep intents (#4442)"
```

---

### Task 7: The release-time schedule brake

**Files:**
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.ts` (`revalidateApprovedIntentForRelease` at `:140`, beside the `laneEvidence` block at `:201-207`)
- Test: `apps/api/src/services/actionIntents/revalidateRelease.test.ts` (existing)

**Interfaces:**
- Produces: `async function checkSweepScheduleBrake(intent: ActionIntent): Promise<{ ok: true } | { ok: false; reason: string }>` — module-private; returns `errorCode: 'agent_policy_denied'` to the caller.

- [ ] **Step 1 (RED): failing tests**

```ts
it('a sweep-minted intent whose partner baseline act_mode was turned off between decide and release is refused agent_policy_denied', …);
it('a sweep-minted intent whose ORG override set act_mode false is refused', …);
it('a sweep-minted intent whose schedule is still armed releases', …);
it('a sweep-minted intent whose schedule row was DELETED is refused — fail closed, not "no schedule, no objection"', …);
it('an alert-triggered intent takes no new query at all', …);
it('a sweep intent that a HUMAN approved (decided_via = user) is NOT subject to the brake — a human decision is not policy autonomy', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** The existing release checks cover the policy flag, the registry entry and the key authorization but know nothing of schedules (`revalidateRelease.ts:84-115`, **verified**) — so flipping `act_mode` off could not revoke an intent already authorized. Add the check next to `laneEvidence`, gated narrowly:

```ts
  // #4442 §3.6 — the ORDINARY brake. Replacing the CREATION gate cannot revoke
  // an intent that is already `approved`; only a release-time re-read can.
  // Scoped to policy-decided sweep intents: a human-approved sweep card is a
  // human decision and is not subject to the autonomy brake.
  const sweepBrake = intent.triggerKind === 'sweep_finding' && intent.decidedVia === 'policy'
    ? await checkSweepScheduleBrake(intent)
    : null;
  if (sweepBrake && !sweepBrake.ok) {
    return { ok: false, errorCode: 'agent_policy_denied', details: { reason: sweepBrake.reason } };
  }
```

`checkSweepScheduleBrake` resolves the run's `schedule_id`, loads the baseline plus this org's override, and applies `effectiveSchedule(...).actMode`. A missing run, a missing schedule or a missing baseline is **refuse**, not allow. Also re-check `sweepActEnabled()` here — the same reason `checkPolicyDecisionEvidence` re-checks `policyDecideEnabled()` (`:84`): an operator flipping the flag off must stop an already-authorized-but-not-yet-released intent.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease src/services/actionIntents/agentReleaseAuthority
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): re-check the schedule act-mode brake at intent release (#4442)"
```

---

### Task 8: The partner ∩ org op-key contract test

**Files:**
- Create: `apps/api/src/__tests__/integration/sweepActOpKeyIntersection.integration.test.ts`

**Interfaces:** none. This task exists because #4442's constraint 3 ("present in BOTH the partner baseline and the org row") needs **no new code** — `mergeAgentPolicies` already intersects (`services/aiAgents/effectivePolicy.ts:297-302`, `intersectToolRefs`) and a missing org row already resolves to `[]` (`:169-194`, the "partner keys are a CEILING, never an inherited GRANT" branch) — but it has never been asserted **on the sweep path**, which is the whole risk.

- [ ] **Step 1 (RED): write the four cases against real Postgres**

```ts
it('key in the partner baseline but NOT in the org row -> the sweep intent is never authorized', …);
it('key in the org row but NOT in the partner baseline -> never authorized (the ceiling holds)', …);
it('NO org row at all, key in the partner baseline -> never authorized (effective set is [])', …);
it('key in BOTH -> the sweep intent authorizes, and exactly one ai_unattended_exposure row is written', …);
```

Drive them end-to-end: seed a partner-wide sweep schedule with `act_mode = true`, a sweep run, and a device-scoped intent with `trigger_kind = 'sweep_finding'`, then call `attemptPolicyDecision` and assert on `action_intents.policy_decision_state` / `.decided_via` and on the `ai_unattended_exposure` rows.

- [ ] **Step 2: run.** `pnpm test-stack up && pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepActOpKeyIntersection.integration.test.ts`. Cases 1–3 should pass immediately (the merge already does the right thing) and case 4 should pass once Tasks 5–6 are in. If case 1, 2 or 3 fails, **stop** — the intersection is not holding on this path and that is a tenancy finding, not a test bug.

- [ ] **Step 3: add the auto-halt case.** P2-5's auto-demote already removes the key from the org row on the first ATTEMPTED `failed` or a watch `recurred`, which makes every subsequent sweep proposal fall back to a human card (spec §3.6). Assert it on the sweep path: a released sweep intent that fails terminally revokes the key, and a **second** sweep occurrence for the same org then produces a `pending_approval` card rather than an authorization.

- [ ] **Step 4: commit**

```bash
git commit -m "test(ai): partner-intersect-org op-key and auto-halt contracts on the sweep act path (#4442)"
```

---

### Task 9: Web — the act-mode toggle and the one-op-key truth

**Files:**
- Modify: `apps/web/src/components/settings/AiAgentSchedulesSection.tsx` (the draft/save shape at `:570-690`)
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/settings.json`
- Test: `apps/web/src/components/settings/AiAgentSchedulesSection.test.tsx` (existing)

- [ ] **Step 1 (RED): failing component tests**

```tsx
it('a partner baseline shows an Act mode toggle, default off', …);
it('an org override shows a "Disable act mode for this organization" switch, and NO way to enable it', …);
it('the toggle is disabled with an explanatory tooltip when canManagePartnerWidePolicies is false', …);
it('arming act mode renders the scope note naming the single supported operation', …);
it('a failed PATCH surfaces an error toast via runAction rather than silently reverting', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** Mutation through `runAction` (`apps/web/src/lib/runAction.ts`) like every other write on this page — it also treats an HTTP-200 `{success:false}` body as a failure. Follow the existing `ownerScope` create-only pattern (`apps/web/src/components/software/PolicyForm.tsx` is the reference for the "All orgs" badge shape).

The **scope note is not optional**. Act mode for sweeps v1 covers exactly one op key, and an operator who arms it expecting vulnerability remediation has been misled by the UI. Copy along the lines of: *"Unattended fixes are limited to restarting a stopped service, and only on devices whose organization has already been granted `manage_services:restart`. Everything else still waits for approval."*

- [ ] **Step 4: 8 real locales**, then run parity + coverage:

```bash
cd apps/web && npx vitest run src/components/settings/AiAgentSchedulesSection src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
pnpm --filter @breeze/web exec tsc --noEmit
git commit -m "feat(web): act-mode toggle on AI agent schedules, tighten-only with the v1 scope stated (#4442)"
```

---

### Task 10: Docs — retire the phase-2 spec's "child run" wording

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (§4.2)

- [ ] **Step 1: rewrite §4.2's act-mode sweep execution paragraph.** The spec called it a "child run"; that phrasing predates `action_intents.scope_kind` / `scope_device_id` (P2-2 Task A3) and is what makes OD-1 B look pre-decided. Replace it with the intent-as-unit model and the table from the new spec's §3.1 (device-exact pinning → `scope_device_id` + `intentTargetScope.ts`; live policy re-run → `policyDecide.ts` and `agentReleaseAuthority.ts`; reserve → `runAuthorizeTransaction`; execute → `intentReleaseWorker`; verify → intent-anchored `ai_agent_fix_watches`; rollup → `impactRollup.ts`).

- [ ] **Step 2: add a dated amendment line** at the bottom of §4.2 pointing at `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §3.1 and OD-1, so the change is traceable and the older document does not read as silently rewritten. Do **not** edit any other section of the phase-2 spec.

- [ ] **Step 3: commit**

```bash
git commit -m "docs(ai): phase-2 §4.2 — the sweep act unit is the device-scoped intent, not a child run (#4442)"
```

---

### Task 11: Live-DB suites, PR

- [ ] **Step 1: run every live-DB suite this wave can redden**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepActOpKeyIntersection.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepIntentVerification.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/createIntentAtomicity.integration.test.ts
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
pnpm test-stack down
```

- [ ] **Step 2: add the `act_mode` tighten-only cases to the partner-RLS suite.** In `aiAgentSchedulesPartnerRls.integration.test.ts`: partner enables and every org under it resolves armed; an org override with `act_mode = false` resolves disarmed; an org override with `act_mode = true` over an unarmed baseline still resolves disarmed; a cross-partner forge is 42501.

- [ ] **Step 3: open the PR.** Body must state: OD-1 A (no child run) and where the six child-run responsibilities actually live; the two-flag design and the byte-identical flag-off control with its output; the five creation gates and the three decide-time ones, each failing closed; that freshness anchors on the intent and the subject rather than `run.finished_at`, and why; the release-time brake; that v1 covers exactly one op key; the `act_mode` three-valued nullability decision and why `NOT NULL DEFAULT false` was rejected. `Closes #<wave sub-issue>`, `Refs #4442`. If stacked, `gh workflow run CI --ref <branch>`.

- [ ] **Step 4: do NOT enable the flag in this PR.** Rollout is W05's last task: one internal partner, one org, one op key, `maxUnattendedDevicesPerSweep = 1`, two weeks of graduation-panel reading before widening.
