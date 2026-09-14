---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD
branch: feature/<parent>-ai-patch-agent/wave-<sub-issue>
---
# AI patch agent W02: actionable installs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

> **Blast radius: HIGH.** This wave turns advice into approval-inbox cards that install software on customer machines. Full rigor: TDD on every task, one independent code-review round, and the live-DB suites are not optional.

**Goal:** An `install` item in a patch plan becomes a device-scoped **Tier-3 supervised** action-intent card in the approvals inbox, carrying only updates that are genuinely eligible for that device *right now*; the same eligibility is re-checked at release so an update superseded, blocked or newly deferred between approval and execution is dropped; and the same `(device, patch)` problem on two consecutive nightly occurrences produces **one** live card, not two.

**Architecture:** Three pieces. (1) A shared, exported `resolvePatchInstallEligibility` extracted from the private core of `patchApprovalEvaluator.ts` — the single gate that both this wave and Operator P4-0/P4-3 use, replacing the per-device manual-install route's partner-only approximation. (2) `persistPatchPlan` (W01) gains a minting branch after its membership gates: intersect the model's `patchIds` against the resolver, then `createActionIntent` with `scope: { deviceId }` and a **problem-derived** idempotency key `patch:<orgId>:<deviceId>:<patchId>` (OD-4 A), guarded by a suppression read over recently-decided intents on the same key. (3) A `'manage_patches:install'` entry in `EFFECT_DIGEST_RESOLVERS` so the existing release worker re-runs the intersection before dispatch — no new hook, no new call site.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Zod, Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-patch-agent-design.md` §3.4, §3.7, OD-3 A, OD-4 A, OD-5 A, and the plan-index corrections 14–17.

**Depends on:** W01 (the lane, the plan contract, `persistPatchPlan`'s gates).

---

## Global Constraints

Everything in W01's Global Constraints still applies. Additionally:

- **No migration in this wave.** No new tables (OD-4 A is the derived-key option precisely to avoid one), no new columns. If the suppression read turns out to be insufficient, the fallback is a durable `ai_patch_episodes` table (OD-4 B) — a shape-1 `org_id` table inheriting **all four** registration lists plus the org-merge registry — and that is a **new wave**, not a late addition to this one.
- **One intent per problem, not per run.** Sweep keys are `sweep:<runId>:<index>` (`sweepFindings.ts:334`), deliberately run-scoped. Patch keys are problem-scoped. `action_intents_org_idem_uniq` (`migrations/2026-07-18-action-intents.sql:83-86`) is `UNIQUE (org_id, idempotency_key) WHERE status IN ('pending_approval','approved','executing')` — **live statuses only**, so a `rejected`/`expired`/`cancelled`/`completed` card frees the key. The suppression read is what stops the nightly re-proposal; the index alone does not.
- **A device-scoped intent is always human-decided.** `resolvePolicyDecisionState` returns `human_required` on `hasScope` before anything else (`intentService.ts:663-679`), so `attemptPolicyDecision` is never reached. Do **not** add a patch exception; #4442 is the roadmap item that would change this.
- **`install` is Tier 3 / `supervised`** (`aiGuardrails.ts` `TIER3_ACTIONS:213`, `TIER3_SUPERVISED_ACTIONS:451`) — one human. **`rollback` is Tier 3 / `four_eyes`** (`TIER3_FOUR_EYES_ACTIONS:335`, entry `:357`) and this program never proposes it.
- **Approvals stay advisory (OD-3 A).** `patch_approvals` is keyed `(partner_id, patch_id, COALESCE(ring_id, nil))` (`db/schema/patches.ts:189-196`) — **partner-wide or ring-wide, never device- or org-scoped** — and `manage_patches:approve` requires partner administration an org-scoped agent principal cannot pass. An `approval_advisory` item mints **no intent**, ever. Any code path that would call `manage_patches:approve` from this program is a bug.
- **`maxActionsPerRun` stays 0 in `patchLimits`** — that governs the *run loop*'s in-turn tool execution. The **post-run minting cap** is the separate `run.maxActionsPerRun` value threaded into the persister, exactly as `sweepFindings.ts:63-68` documents for sweeps. Wire it the same way; do not conflate them.
- **The AI-tool path has no MFA gate** (`aiGuardrails.ts`/`aiToolsFleet.ts`/`aiAgentSdkTools.ts`: zero `requireMfa` hits), while the human REST install route has one (`routes/devices/patches.ts:497`). That asymmetry is **pre-existing and out of scope**; record it on the parent issue and do not widen it.
- **`vitest run` is a substring match** — `src/routes/devices/patches` pulls in every dotted sibling; check the file count.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/patchEligibility.ts` (new, + `.test.ts`) | `resolvePatchInstallEligibility`, `PatchInstallEligibility`, `PatchIneligibleReason` (Task 1). |
| `apps/api/src/services/patchApprovalEvaluator.ts` (modify) | Export the decision core; `resolveApprovedPatchesForDevice` becomes a thin caller (Task 1). |
| `apps/api/src/jobs/patchJobExecutor.ts` (verify only) | Its `resolveApprovedPatchesForDevice` call (`:1145`) must behave identically (Task 1). |
| `apps/api/src/services/aiAgents/patchEpisode.ts` (new, + `.test.ts`) | `patchEpisodeIdempotencyKey`, `readRecentPatchEpisodeIntents`, `shouldSuppressPatchEpisode` (Task 2). |
| `apps/api/src/services/actionIntents/intentQuery.ts` (new, + `.test.ts`) | `findIntentsByIdempotencyKey(orgId, keys, since)` — the helper that does not exist today (Task 2). |
| `apps/api/src/services/aiAgents/patchPlan.ts` (modify), `patchPlan.test.ts` | The minting branch: intersect → suppress → `createActionIntent` (Task 3). |
| `apps/api/src/services/aiAgents/patchProfile.ts`, `runService.ts` (modify) | Thread the post-run action cap (Task 3). |
| `apps/api/src/services/actionIntents/effectDigest.ts` (modify), `effectDigestCoverage.contract.test.ts` | `'manage_patches:install'` resolver — the release re-intersection (Task 4). |
| `apps/api/src/services/aiAgents/runTrace.ts`, web `RunDetailPage.tsx`, 8 × `settings.json` | Render intent linkage and the new dispositions (Task 5). |
| `apps/api/src/__tests__/integration/aiAgentPatchInstall.integration.test.ts` | Live-DB: one card across two occurrences, suppression, release drop (Task 6). |

---

### Task 0: Verify the eligibility surface before touching it

**Files:** read-only.

- [ ] **Step 1: Confirm the extraction boundary**

Read and record in the PR body (these are the facts the whole wave rests on; re-verify, do not trust this plan):

- `apps/api/src/services/patchApprovalEvaluator.ts` — header line 13 says *"Manual per-device installs do NOT pass through this evaluator"*, and `:415` says *"per-device installs bypass this evaluator entirely"*.
- Exported today: `resolveApprovedPatchesForDevice` (`:324`), `isCategoryAllowed` (`:166`), `buildAllowedPatchSources` (`:193`), `isThirdPartyPatchSource` (`:217`), `isUnratedSeverity` (`:229`), `comparePatchVersions` (`:245`), `appRuleKey`/`buildAppRuleMap`/`evaluateAppRule` (`:282`/`:292`/`:306`), `parseRingAutoApprove` (`:747`), `canonicalizePatchCategory` (`:130`), plus the types.
- **Private today:** `evaluatePatchApproval` (`:534-651`) — the priority-ordered decision (manual approval → category rule → ring auto-approve) — and `isHeldByDeferral` (`:653`), which anchors on `patches.release_date` and falls back to `device_patches.created_at` for third-party sources, failing closed otherwise. These two are the extraction.
- `resolveApprovedPatchesForDevice` has exactly **one** caller on `main`: `jobs/patchJobExecutor.ts:25` (import), `:1145` (call).
- `routes/devices/patches.ts` `POST /:id/patches/install` (`:493-612`) calls `getApprovedPatchIdsForPartner` (`:188-212`) only — the partner-wide manual-approval gate, which its own comment at `:183-186` admits lets *"a patch approved for ring A pass for a device in ring B"*.
- `EFFECT_DIGEST_RESOLVERS` (`services/actionIntents/effectDigest.ts:157`) has **no** `manage_patches` entry; `manage_patches:rollback` sits on `DELIBERATELY_UNPINNED` in `effectDigestCoverage.contract.test.ts:74-75` because `patches` is a **global vendor catalog** whose `updated_at` churns on routine re-sync.

- [ ] **Step 2: Record the manual-route gap as its own issue**

This wave does **not** re-point `POST /:id/patches/install` through the new resolver — that changes human-facing behaviour for every technician and belongs to P4-0. File it:

```bash
gh issue create --repo LanternOps/breeze \
  --title "Manual per-device patch install bypasses ring/category eligibility" \
  --label bug \
  --body "routes/devices/patches.ts:188-212 gates the manual install on getApprovedPatchIdsForPartner — the partner-wide manual-approval set only. Its own comment (:183-186) records the consequence: a patch approved for ring A passes for a device in ring B, and deferral/category/app-rule exclusions are not applied at all. AI patch agent W02 extracts services/patchEligibility.ts:resolvePatchInstallEligibility as the shared gate; re-pointing the human route through it is Operator P4-0's 'intersect with current eligibility inside the actual device executor' bullet and is deliberately NOT done in W02."
```

---

### Task 1: Extract the shared eligibility resolver

**Files:**
- Create: `apps/api/src/services/patchEligibility.ts`, `apps/api/src/services/patchEligibility.test.ts`
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`
- Verify: `apps/api/src/jobs/patchJobExecutor.ts` (behaviour must be byte-identical)

**Interfaces produced:**
```ts
export type PatchIneligibleReason =
  | 'not_outstanding'        // device_patches.status not in OUTSTANDING_DEVICE_PATCH_STATUSES
  | 'superseded'             // patches.superseded_by is set
  | 'held_by_deferral'
  | 'blocked_by_category'
  | 'blocked_by_app_rule'
  | 'awaiting_manual_approval'
  | 'no_ring_resolved'
  | 'device_not_in_org';
export interface PatchInstallEligibility {
  eligible: Array<{ patchId: string; devicePatchId: string; approvalReason: ApprovalReason; requiresReboot: boolean }>;
  ineligible: Array<{ patchId: string; reason: PatchIneligibleReason }>;
  ringId: string | null;
  resolvedAt: string;        // ISO — what the release-time re-check compares against
}
export async function resolvePatchInstallEligibility(args: {
  deviceId: string; orgId: string; patchIds?: string[];   // undefined = every outstanding patch
}): Promise<PatchInstallEligibility>;
```

- [ ] **Step 1: Write the failing tests**

`patchEligibility.test.ts` — table-driven over the priority order the private `evaluatePatchApproval` encodes, plus the negative cases the current manual route gets wrong:

```ts
it('a manual approval for the DEVICE\'S ring makes a patch eligible', async () => { /* … */ });
it('a manual approval for a DIFFERENT ring does NOT', async () => {
  // the exact bug routes/devices/patches.ts:183-186 admits to
  expect(res.ineligible).toContainEqual({ patchId: P, reason: 'awaiting_manual_approval' });
});
it('a partner-wide blanket approval (ring_id NULL) applies to every ring', async () => { /* COALESCE(ring_id, nil) semantics */ });
it('reports held_by_deferral before the deferral window elapses and eligible after', async () => { /* release_date anchor */ });
it('anchors a third-party patch deferral on device_patches.created_at when release_date is null', async () => { /* … */ });
it('fails CLOSED when neither anchor exists', async () => { /* held_by_deferral, not eligible */ });
it('reports blocked_by_category for an excluded category and blocked_by_app_rule for a denied app', async () => { /* … */ });
it('reports superseded when patches.superseded_by is set', async () => { /* … */ });
it('reports not_outstanding for status = missing (the tombstone) as well as installed', async () => {
  // db/schema/patches.ts:53-68 — 'missing' is a stale-scan tombstone, NOT "the device needs it"
});
it('reports no_ring_resolved when the device matches no enabled ring', async () => { /* never silently eligible */ });
it('narrows to the requested patchIds and never widens beyond them', async () => { /* … */ });
it('resolveApprovedPatchesForDevice returns exactly what it returned before the extraction', async () => {
  // golden-fixture parity: same inputs, same ApprovedPatch[] ordering and fields
});
```

```bash
cd apps/api && npx vitest run src/services/patchEligibility.test.ts src/services/patchApprovalEvaluator.test.ts src/jobs/patchJobExecutor.test.ts
```

- [ ] **Step 2: Implement**

Move the private core out, do not copy it:

1. Export `evaluatePatchApproval` and `isHeldByDeferral` from `patchApprovalEvaluator.ts` (or move both into `patchEligibility.ts` and have the evaluator import them — pick one direction and make it the only one; **two implementations of the deferral rule is the failure mode this task exists to prevent**).
2. `resolvePatchInstallEligibility` composes: resolve the device's org and partner → resolve the device's effective ring (`ApprovalEvaluationConfig`) → load the candidate `device_patches` rows joined `patches`, pinned `device_patches.org_id = $orgId` **and** `devices.org_id = $orgId`, statuses in `OUTSTANDING_DEVICE_PATCH_STATUSES` → load the partner's `patch_approvals` (`partner_id`, `COALESCE(ring_id, nil)`) → run the decision per candidate → bucket into `eligible` / `ineligible` **with a reason for every exclusion**.
3. `resolveApprovedPatchesForDevice` becomes a thin adapter over it, preserving its exact `ApprovedPatch[]` shape and ordering so `patchJobExecutor.ts:1145` is untouched. Its golden-fixture parity test above is the proof.
4. `superseded` is a **new** exclusion this program needs and the executor path may not have applied — check `patchJobExecutor`'s behaviour first. If the executor did not exclude superseded patches, **do not change its behaviour in this task**: gate the new exclusion behind an explicit option (`{ excludeSuperseded: true }`) that only the AI path passes, and file the executor gap separately.

Every function stays **read-only**. This module never writes.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/patchEligibility.test.ts src/services/patchApprovalEvaluator.test.ts src/jobs/patchJobExecutor.test.ts src/routes/devices/patches.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
git add apps/api/src && git commit -m "refactor(patches): extract the shared install-eligibility resolver from patchApprovalEvaluator"
```

---

### Task 2: Episode identity — the derived key and the suppression read

**Files:**
- Create: `apps/api/src/services/actionIntents/intentQuery.ts`, `intentQuery.test.ts`
- Create: `apps/api/src/services/aiAgents/patchEpisode.ts`, `patchEpisode.test.ts`

**Interfaces produced:**
```ts
// intentQuery.ts — the helper that genuinely does not exist on main
export async function findIntentsByIdempotencyKey(args: {
  orgId: string; keys: string[]; since: Date;
}): Promise<Array<{ idempotencyKey: string; status: ActionIntentStatus; createdAt: Date; decidedAt: Date | null }>>;

// patchEpisode.ts
export const PATCH_EPISODE_SUPPRESSION_DAYS = 14;
export const PATCH_EPISODE_COMPLETED_COOLDOWN_DAYS = 7;
export function patchEpisodeIdempotencyKey(orgId: string, deviceId: string, patchId: string): string;
export type PatchEpisodeSuppression =
  | { suppress: false }
  | { suppress: true; reason: 'live_intent_exists' | 'recently_rejected' | 'recently_cancelled' | 'recently_completed' };
export function shouldSuppressPatchEpisode(
  history: Array<{ status: ActionIntentStatus; createdAt: Date; decidedAt: Date | null }>, now: Date,
): PatchEpisodeSuppression;
```

- [ ] **Step 1: Write the failing tests**

`patchEpisode.test.ts` — pure, no DB:

```ts
it('derives a stable problem-scoped key', () => {
  expect(patchEpisodeIdempotencyKey('o', 'd', 'p')).toBe('patch:o:d:p');
  expect(patchEpisodeIdempotencyKey('o', 'd', 'p')).toBe(patchEpisodeIdempotencyKey('o', 'd', 'p'));
});
it('suppresses while a live intent exists', () => {
  for (const status of ['pending_approval', 'approved', 'executing'] as const) {
    expect(shouldSuppressPatchEpisode([{ status, createdAt: now, decidedAt: null }], now))
      .toEqual({ suppress: true, reason: 'live_intent_exists' });
  }
});
it('suppresses for 14 days after a rejection and re-proposes on day 15', () => { /* boundary both sides */ });
it('suppresses for 7 days after a completion and re-proposes after', () => {
  // a completed install that did not take is a real problem — but not a nightly one
});
it('does NOT suppress after an expiry', () => {
  // nobody decided; the card simply aged out, and the problem is still real
  expect(shouldSuppressPatchEpisode([{ status: 'expired', createdAt: old, decidedAt: null }], now)).toEqual({ suppress: false });
});
it('does NOT suppress after a failure', () => { /* a failed install must be re-proposable — W03 turns it into a chase */ });
it('takes the MOST RECENT decision when the history has several', () => { /* ordering, not first-match */ });
it('treats an empty history as not suppressed', () => { /* first ever proposal */ });
```

`intentQuery.test.ts`:

```ts
it('reads only this org\'s intents, in ONE query, for up to N keys', async () => { /* inArray, one select, org pinned */ });
it('returns rows in most-recent-first order per key', async () => { /* … */ });
it('runs inside a system DB context and never bare-pool', async () => { /* … */ });
```

```bash
cd apps/api && npx vitest run src/services/aiAgents/patchEpisode.test.ts src/services/actionIntents/intentQuery.test.ts
```

- [ ] **Step 2: Implement**

`findIntentsByIdempotencyKey` is a single `SELECT idempotency_key, status, created_at, decided_at FROM action_intents WHERE org_id = $1 AND idempotency_key = ANY($2) AND created_at >= $3 ORDER BY created_at DESC`, run through the same system-context idiom `sweepFindings.inSystemDbContext` uses (`:113-127`). Pin `org_id` — the key alone is not a tenant boundary. Cap `keys.length` and batch above the cap.

`shouldSuppressPatchEpisode` is pure and total: it takes the history the query returned for one key and the clock. The rules, in order: any live status (`pending_approval|approved|executing`) → suppress; else the most recent terminal decision — `rejected` or `cancelled` inside `PATCH_EPISODE_SUPPRESSION_DAYS` → suppress; `completed` inside `PATCH_EPISODE_COMPLETED_COOLDOWN_DAYS` → suppress; `expired` or `failed` → **do not suppress**. Document each rule's *why* inline, especially the two negatives: an expired card means nobody decided, and a failed install is exactly the input W03's chase loop needs.

`patchEpisodeIdempotencyKey` returns the literal `patch:<orgId>:<deviceId>:<patchId>`. **Pass it as `createActionIntent`'s explicit `idempotencyKey`** — `deriveIntentIdempotencyKey` (`intentService.ts:540`) uses `explicitKey ?? deriveIdempotencyKey(...)`, so an explicit key wins and is stored verbatim, which is what makes the suppression read possible. Do not let it fall through to the sha256 derivation (that key is actor- and digest-scoped and would change whenever the proposed patch set changed).

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/patchEpisode.test.ts src/services/actionIntents/intentQuery.test.ts
git add apps/api/src && git commit -m "feat(ai): problem-derived patch episode key and cross-occurrence suppression"
```

---

### Task 3: Mint the install cards

**Files:**
- Modify: `apps/api/src/services/aiAgents/patchPlan.ts`, `patchPlan.test.ts`
- Modify: `apps/api/src/services/aiAgents/patchProfile.ts` / `runFinalizers.ts` (thread the post-run action cap)
- Modify: `packages/shared/src/types/aiPatchPlan.ts` (disposition/reason unions)

- [ ] **Step 1: Write the failing tests**

```ts
it('mints ONE device-scoped Tier-3 intent per eligible install item', async () => {
  expect(createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
    toolName: 'manage_patches',
    input: expect.objectContaining({ action: 'install', deviceId: DEV, patchIds: ['p1', 'p2'] }),
    source: 'ai_agent', orgId: ORG,
    reason: 'Install 2 critical updates on WS-014',    // the item TITLE, one bounded line
    idempotencyKey: `patch:${ORG}:${DEV}:p1`,
    scope: { deviceId: DEV },
  }));
});
it('drops ineligible patchIds from the card and records why, instead of refusing the whole item', async () => {
  eligibility.mockResolvedValue({ eligible: [{ patchId: 'p1' }], ineligible: [{ patchId: 'p2', reason: 'held_by_deferral' }] });
  expect(mintedInput.patchIds).toEqual(['p1']);
  expect(dispositions[0].droppedPatchIds).toEqual([{ patchId: 'p2', reason: 'held_by_deferral' }]);
});
it('refuses the item entirely when NOTHING is eligible', async () => {
  expect(createActionIntent).not.toHaveBeenCalled();
  expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'no_eligible_patches' });
});
it('suppresses a repeat proposal for the same (device, patch) on the next occurrence', async () => {
  expect(dispositions[0]).toMatchObject({ disposition: 'suppressed', reason: 'live_intent_exists' });
  expect(createActionIntent).not.toHaveBeenCalled();
});
it('stops at the run action cap and records cap_reached', async () => { /* run.maxActionsPerRun, sweepFindings.ts:312-320 shape */ });
it('never mints for an approval_advisory item', async () => {
  // OD-3 A. patch_approvals is partner/ring-scoped; a device card would be a blast-radius lie.
  expect(createActionIntent).not.toHaveBeenCalled();
});
it('never links a cancelled snapshot', async () => {
  createActionIntent.mockResolvedValue({ id: 'i1', status: 'cancelled', errorCode: 'no_eligible_approvers' });
  expect(intentIds).toEqual([]);
  expect(dispositions[0]).toMatchObject({ disposition: 'error', reason: 'no_eligible_approvers' });
});
it('logs but never persists an intent error message', async () => { /* sweepFindings.ts:131-138 rule */ });
it('resolves eligibility ONCE per device, not once per patch', async () => { /* batching */ });
it('runs the eligibility resolution AFTER the W01 membership gates', async () => {
  // a device that failed gate 1 must never reach a query
  expect(resolvePatchInstallEligibility).not.toHaveBeenCalled();
});
```

```bash
cd apps/api && npx vitest run src/services/aiAgents/patchPlan.test.ts
```

- [ ] **Step 2: Implement**

Extend `persistPatchPlan`'s loop after W01's gates 1 and 2, keeping the same record-per-item shape:

1. Group the surviving `install` (and, from W03, `chase`) items by `deviceId`; call `resolvePatchInstallEligibility({ deviceId, orgId, patchIds })` **once per device**.
2. Intersect: keep only eligible ids. Empty → `disposition: 'refused', reason: 'no_eligible_patches'`. Partial → mint with the survivors and record `droppedPatchIds`.
3. Build the keys (`patchEpisodeIdempotencyKey` per surviving patch id) and do **one** `findIntentsByIdempotencyKey` for the whole run; `shouldSuppressPatchEpisode` per key. Suppressed → `disposition: 'suppressed'` with the reason. **The key on the intent is the FIRST surviving patch id's key**, and every other surviving patch id in the same card is recorded on the disposition so the suppression read still sees them next time — document this: a multi-patch card has one key, and the plan deliberately accepts that a second card can appear for a patch that was bundled into a suppressed one. If that proves wrong in practice, it is the OD-4 B trigger.
4. `isToolAllowlisted(run.toolAllowlist, 'manage_patches', 'install')` — the same allowlist gate sweeps apply (`sweepFindings.ts:303-310`). Not allowlisted → `refused / not_allowlisted`.
5. `created >= run.maxActionsPerRun` → `cap_reached`.
6. `createActionIntent(agentAuth, { … })` exactly as the test above pins. Link the intent **only** when the returned snapshot is `pending_approval` (`sweepFindings.ts:342-351`) — `createActionIntent` commits then immediately cancels when nobody can approve.

Thread the post-run cap the way sweeps do: `patchLimits` keeps `maxActionsPerRun: 0` for the run loop, and `runFinalizers` passes the **resolved policy** `maxActionsPerRun` into `persistPatchPlan` as `run.maxActionsPerRun` (`runFinalizers.ts:204-206`, `:463-468` are the existing precedents). Add a comment saying which is which; conflating them is how a patch run would either mint nothing or mint unbounded.

`PatchPlanItemDisposition` gains `'suppressed'`; `PatchPlanRefusalReason` gains `'no_eligible_patches'`, `'not_allowlisted'`, `'max_actions_per_run'`, `'no_eligible_approvers'`, `'intent_error'`, plus the `PatchIneligibleReason` values used in `droppedPatchIds`.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/patchPlan.test.ts src/services/aiAgents/runFinalizers.test.ts src/services/aiAgents/runLoop.patch.test.ts
git add apps/api/src packages/shared/src && git commit -m "feat(ai): mint device-scoped Tier-3 patch install proposals with eligibility intersection and episode suppression"
```

---

### Task 4: Re-intersect at release

**Files:**
- Modify: `apps/api/src/services/actionIntents/effectDigest.ts` (`EFFECT_DIGEST_RESOLVERS` `:157`)
- Modify: `apps/api/src/services/actionIntents/effectDigestCoverage.contract.test.ts`
- Modify: `apps/api/src/services/actionIntents/effectDigest.test.ts`
- Verify: `apps/api/src/jobs/intentReleaseWorker.ts` (`:986-1033`) — **no change**

- [ ] **Step 1: Write the failing tests**

```ts
it('registers a manage_patches:install resolver', () => {
  expect(Object.keys(EFFECT_DIGEST_RESOLVERS)).toContain('manage_patches:install');
});
it('hashes the ELIGIBILITY VERDICT, not patches.updated_at', async () => {
  // the exact trap effectDigestCoverage.contract.test.ts:74-75 records for rollback:
  // `patches` is a global vendor catalog re-synced on a schedule, so its updated_at
  // churns independently of anything the approver saw.
  const a = await resolve({ deviceId: D, patchIds: ['p1'] }, db);
  await bumpPatchesUpdatedAt('p1');
  const b = await resolve({ deviceId: D, patchIds: ['p1'] }, db);
  expect(b.digest).toBe(a.digest);
});
it('changes the digest when a patch becomes ineligible between approval and release', async () => {
  await deferPatch('p1');
  expect((await resolve({ deviceId: D, patchIds: ['p1'] }, db)).digest).not.toBe(a.digest);
});
it('changes the digest when a patch is superseded', async () => { /* … */ });
it('changes the digest when the device moved ring', async () => { /* … */ });
it('changes the digest when the device moved org', async () => { /* the intent must not release */ });
it('the release worker fails the intent with content_changed on a mismatch', async () => {
  // intentReleaseWorker.ts:986-1033, unchanged
  expect(failIntent).toHaveBeenCalledWith(expect.anything(), 'content_changed');
});
```

```bash
cd apps/api && npx vitest run src/services/actionIntents/effectDigest.test.ts src/services/actionIntents/effectDigestCoverage.contract.test.ts src/jobs/intentReleaseWorker.test.ts
```

- [ ] **Step 2: Implement**

Add one entry to `EFFECT_DIGEST_RESOLVERS`:

```ts
// AI patch agent W02. The pinned content is the ELIGIBILITY VERDICT for
// (deviceId, patchId…), never the `patches` catalog row: `patches` is a
// GLOBAL vendor catalog re-synced on a schedule, so hashing its `updated_at`
// would fail closed on routine syncs — the exact trap recorded for
// `manage_patches:rollback` in effectDigestCoverage.contract.test.ts:74-75.
// A patch that was deferred, category-blocked, superseded, un-approved, or
// whose device changed ring or org between approval and release therefore
// changes the digest and the worker refuses the release with `content_changed`.
'manage_patches:install': async (args, database) => {
  const { deviceId, patchIds, orgId } = readArgs(args);
  const verdict = await resolvePatchInstallEligibility({ deviceId, orgId, patchIds });
  return { digest: sha256(canonical({
    ringId: verdict.ringId,
    eligible: verdict.eligible.map((e) => e.patchId).sort(),
    ineligible: verdict.ineligible.map((e) => `${e.patchId}:${e.reason}`).sort(),
  })) };
},
```

Resolve `orgId` from the intent's own org, never from the tool input. Remove `manage_patches:install` from any `DELIBERATELY_UNPINNED`/"not required" list if the coverage contract carries one for supervised actions; leave `manage_patches:rollback`'s entry exactly as it is.

**The release worker needs no change.** `hasPinnedDigest(intent)` + `computeEffectDigestForRelease` at `:986-1033` picks the new resolver up automatically. The tool-agnostic `revalidateApprovedIntentForRelease` (`services/actionIntents/revalidateRelease.ts:140-316`) also already re-checks approval binding, argument digest, tier escalation, actor and org — do not duplicate any of that.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/actionIntents/ src/jobs/intentReleaseWorker.test.ts
git add apps/api/src && git commit -m "feat(intents): re-intersect patch install eligibility at release via the effect digest"
```

---

### Task 5: Surface the linkage

**Files:**
- Modify: `apps/api/src/services/aiAgents/patchPlan.ts` (`projectPatch`), `runTrace.ts`
- Modify: `apps/web/src/components/aiAgents/RunDetailPage.tsx`, `RunDetailPage.test.tsx`
- Modify: 8 × `apps/web/src/locales/*/settings.json`

- [ ] **Step 1: Write the failing tests**

```tsx
it('links each minted install item to its approval card', () => {
  expect(screen.getByTestId('ai-agent-run-patch-item-0-intent')).toHaveAttribute('href', expect.stringContaining(INTENT_ID));
});
it('renders the dropped patches and their reasons', () => { /* … */ });
it('renders a suppressed item with its suppression reason, not as a silent gap', () => { /* … */ });
it('renders an advisory item with no approve control at all', () => {
  expect(screen.queryByTestId('ai-agent-run-patch-item-1-intent')).toBeNull();
});
```

- [ ] **Step 2: Implement**

`projectPatch` carries `intentId`, `disposition`, `reason`, `droppedPatchIds` per item — display values only, still defensive against a corrupt jsonb. The run-detail section renders the item class label, the target hostname (from the existing `deviceHostnames` map, never a model-authored string), the disposition, and a link to the approval card where one exists. Real translations in all 8 locales for every new key.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/runTrace.test.ts src/services/aiAgents/patchPlan.test.ts
cd apps/web && npx vitest run src/components/aiAgents/RunDetailPage.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/translationCoverage.test.ts
git add apps/api/src apps/web/src && git commit -m "feat(web): render patch install proposals, drops and suppressions on the run trace"
```

---

### Task 6: Live-DB integration and the full sweep

**Files:**
- Create: `apps/api/src/__tests__/integration/aiAgentPatchInstall.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Real Postgres, real `action_intents`, real RLS.

```ts
it('the same (device, patch) on two consecutive occurrences yields exactly ONE live intent', async () => { /* the top production risk */ });
it('a rejected card is suppressed on the next occurrence and re-proposed after the window', async () => { /* … */ });
it('an expired card is re-proposed immediately', async () => { /* … */ });
it('release revalidation drops a patch that became deferred after approval', async () => { /* content_changed */ });
it('release revalidation drops a patch that became superseded after approval', async () => { /* … */ });
it('an intent for a device that moved org does not release', async () => { /* … */ });
it('the minted intent is device-scoped and pending_approval — never policy-decided', async () => {
  expect(row.scope_kind).toBe('device');
  expect(row.policy_decision_state).toBe('human_required');   // intentService.ts:663-679
});
it('an approval_advisory item writes NO patch_approvals row and mints no intent', async () => {
  expect(await countApprovals(PARTNER)).toBe(0);
});
it('the unique index rejects a second live intent on the same key', async () => { /* action_intents_org_idem_uniq */ });
it('a cross-org forge of the eligibility read returns zero rows', async () => { /* … */ });
```

- [ ] **Step 2: Run everything**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentPatchInstall.integration.test.ts src/__tests__/integration/aiAgentPatchLane.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls.ts
pnpm test-stack down
cd apps/api && npx vitest run                # whole unit suite
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run && npx astro check
pnpm lint
```

- [ ] **Step 3: Independent code review, then the PR**

High blast radius ⇒ **one** independent review round (`/pr-review-toolkit:review-pr`), acted on, recorded on the PR. Re-review only if a fix itself touched eligibility, intent minting or the release path.

```bash
git add apps/api/src && git commit -m "test(ai): live-DB patch install proposal, suppression and release-revalidation suite"
```

PR body: `Closes #<sub-issue>`, plus an explicit statement of what a technician now sees (a Tier-3 supervised card, one human, per device) and what they still never see (a partner-wide approval written by an agent).

---

## Wave exit criteria

- [ ] `resolvePatchInstallEligibility` is the **only** implementation of patch install eligibility; `resolveApprovedPatchesForDevice` is a thin adapter and `patchJobExecutor` behaves identically (golden-fixture parity test).
- [ ] An `install` item becomes one device-scoped Tier-3 supervised card carrying only currently-eligible patch ids, with every drop recorded and reasoned.
- [ ] The same problem on two nights produces one live card; a rejection suppresses for 14 days; an expiry does not suppress.
- [ ] A patch that became ineligible between approval and release stops the release with `content_changed` — proven against real Postgres.
- [ ] `approval_advisory` writes nothing and mints nothing; `patch_approvals` row count is unchanged by any run.
- [ ] Still no new tables, no new columns, no registry edits — all four tenancy suites green.
