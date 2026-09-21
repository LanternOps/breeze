---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (register after Gate B)
branch: feature/<parent>-ai-sweeps-act-mode/wave-<sub-issue>
---

# AI sweeps act mode — W02: sweep-condition fix watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop crediting `verified` to sweep-minted intents that nothing ever verified. Give `ai_agent_fix_watches` an alert-less, **subject**-anchored shape, grade it by re-probing the condition the finding was about, and make `watchReleasedIntent`'s "no watch is possible" branch stop firing for sweep intents.

**Architecture:** `ai_agent_fix_watches` gains `subject_kind` + `subject_key` (no new device column — `device_id` is already `NOT NULL` and carries the intent's scoped device). A new leaf module `apps/api/src/services/aiAgents/sweepSubjectProbe.ts` exposes one `probeSweepSubject(kind, orgId, deviceId, subjectKey) → 'present' | 'cleared' | 'unknown'` per act-eligible kind — a **verification** API, deliberately not the fleet-wide, threshold-bearing, MAX+1 sampling loaders in `sweepEvidence.ts`. `createSweepFixWatchRow` in `fixWatch.ts` is the alert-less sibling of `createIntentFixWatchRow`, reusing the same partial `intent_id` UNIQUE arbiter and the same `source_kind: 'intent'` / `op_keys` shape, so `recordWatchVerdictEvidence` grades it with **no change at all**. `checkFixWatchPhase1` / `checkFixWatchPhase2` branch on `subject_kind`: probe instead of reading the alert. `watchReleasedIntent` (`intentReleaseWorker.ts:544-570`) tries the sweep watch before it can reach the unconditional-`verified` fallback.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL 16, BullMQ (`fixWatchWorker`), Vitest (unit with Drizzle mocks; integration against real Postgres).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §1.1 (the blocker), §3.4 (three outcomes, not two), §3.8 (the watch shape), §10 ("the one that actually protects us"), review-log findings 1 and 6. Gate A approved.

**Tracking:** part of the #4442 cluster. Hub: `docs/superpowers/plans/ai-mcp/2026-09-13-ai-sweeps-act-mode.md`. **Depends on W01** (`action_intents.trigger_kind` is how a sweep-minted intent is recognised). **W04 and W05 must not start until this has merged** — until then P2-5's graduation ladder is a click-counter for the sweep lane.

## The defect, verified

`watchReleasedIntent` grades a released intent three ways (`apps/api/src/jobs/intentReleaseWorker.ts:544-570`). Its middle branch — *"no watch is POSSIBLE (the run has no triggering alert …) → credit `verified` on the same source id, in the same transaction"* — fires for **every** sweep intent, because the anchor's `alertId` is read straight off `ai_agent_runs.alert_id` (`:454`, `:462`) and a sweep run is `trigger_kind: 'schedule'` with no alert, while `createIntentFixWatchRow` requires a non-null `IntentForWatch.alertId` (`fixWatch.ts:286-300`, `:318`). The rationale for that branch (P2-5 C4: *"an operation no watch will ever look at must not sit un-gradeable forever"*) is sound; it is the premise "no watch is possible" that stops being true here.

## Global Constraints

- Migration filename `apps/api/migrations/2026-10-16-181505-sweep-condition-fix-watches.sql` — inside this cluster's reserved `1815xx` block, sorting after W01's `181500` and before W03's `181510`. Re-check `ls apps/api/migrations | sort | tail -1` on `origin/main` before pushing; bump upward only; never rename for today's date.
- **Pure DDL, no DML.** Existing watches keep `subject_kind IS NULL`, which is exactly "this is an alert-anchored watch" — the branch predicate everywhere. `migrationRlsScope.test.ts` therefore stays green with no elevation.
- **`alert_id` is already nullable** — `2026-09-18-ai-agents-safety-controls.sql:50` (`alert_id uuid REFERENCES alerts(id) ON DELETE SET NULL`) and `schema/aiAgentFixWatches.ts:66` (no `.notNull()`), **verified**. Do not "make it nullable"; there is nothing to relax. What the spec's §6 note actually asks for is a test that the one-watch-per-intent invariant (`ai_agent_fix_watches_intent_uq`, the partial UNIQUE on `intent_id`) still holds for the new shape. Task 3 Step 1 writes it.
- **No `subject_device_id`.** `device_id` is already `NOT NULL` with no FK (`schema/aiAgentFixWatches.ts:68`) and a sweep watch sets it to the intent's `scope_device_id`. Two device columns with no precedence rule is how the wrong one gets read.
- Keep `source_kind: 'intent'`. The `ai_agent_fix_watches_source_kind_chk` CHECK admits only `act_run | intent`, the `ai_agent_fix_watches_intent_shape_chk` cross-column rule is `(source_kind = 'intent') = (intent_id IS NOT NULL)` — a sweep watch satisfies both — and `recordWatchVerdictEvidence` maps `source_kind === 'intent'` to `namespace: 'policy_key'` (`fixWatch.ts:551`), which is the namespace the graduation ladder reads. **Adding a third `source_kind` would silently move sweep evidence out of the ladder.**
- `AI_AGENT_EVIDENCE_SOURCE_KINDS` is **not** extended (spec §3.7, review-log finding 8): that column records what terminal event produced the row, not what caused the action.
- Registration lists: no new tables (`ai_agent_fix_watches` is already at `tenantCascade.ts:243`). Two new `included` columns in `CORE_TENANT_EXPORT_POLICY`'s entry at `tenantExportPolicyRegistry.ts:53`.
- **`unknown` never writes a `failed` evidence row.** A device that is offline, or a probe that cannot answer, is not a failed remediation. The only writers of `failed` stay where they are.
- Every task: red test first, then `pnpm --filter @breeze/api exec tsc --noEmit`, targeted tests, one commit.

---

### Task 1: The control test — prove today's behaviour is wrong, against a live DB

**Files:**
- Create: `apps/api/src/__tests__/integration/sweepIntentVerification.integration.test.ts`

**Interfaces:** none — this task ships a failing test and nothing else. It is the whole point of the wave.

- [ ] **Step 1 (RED): write the control.** It must discriminate, not merely assert an absence. On `origin/main` both assertions fail, and they fail for the *right* reason (a `verified` row exists and no watch exists) — check the failure message says exactly that before moving on.

```ts
// Seed: a partner, an org, a device, a sweep-profile ai_agent_runs row with
// alert_id NULL / trigger_kind 'schedule', and a device-scoped action_intent
// with trigger_kind = 'sweep_finding' (W01), approved, then released.
it('a released sweep-minted intent opens a verification episode and is NOT credited verified on release', async () => {
  await releaseTheIntent(intentId);

  const evidence = await db.execute(sql`
    SELECT metric FROM ai_agent_op_evidence
    WHERE source_kind = 'intent' AND source_id = ${intentId}`);
  expect(evidence.map((r) => r.metric)).toEqual(['executed']);   // today: ['executed','verified']

  const [watch] = await db.execute(sql`
    SELECT state, subject_kind, subject_key, alert_id, device_id
    FROM ai_agent_fix_watches WHERE intent_id = ${intentId}`);
  expect(watch).toBeDefined();                                    // today: undefined
  expect(watch.state).toBe('pending');
  expect(watch.subject_kind).toBe('service_down');
  expect(watch.alert_id).toBeNull();
  expect(watch.device_id).toBe(deviceId);
});

it('an ALERT-anchored intent is unaffected — it still opens an alert watch and is still not credited on release', async () => { /* … */ });

it('a released intent with neither an alert nor a sweep trigger is STILL credited verified on release (P2-5 C4 is preserved)', async () => {
  // The regression guard for the branch we are narrowing, not deleting.
});
```

- [ ] **Step 2: run it and record the red**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepIntentVerification.integration.test.ts
```

Expected: cases 1 fails on both assertions, case 3 passes. Paste the failure into the PR body — this is the evidence that the control discriminates, and per `evidence-discipline` a red you did not watch is not a red.

- [ ] **Step 3: commit the failing test on its own**

```bash
git commit -m "test(ai): failing control — sweep intents are credited verified with no verification (#4442)"
```

---

### Task 2: Migration — subject columns + export-policy registration

**Files:**
- Create: `apps/api/migrations/2026-10-16-181505-sweep-condition-fix-watches.sql`
- Modify: `apps/api/src/db/schema/aiAgentFixWatches.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`ai_agent_fix_watches` entry at `:53`)
- Test: `apps/api/src/db/schema/aiAgentFixWatches.test.ts` (existing), `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`

**Interfaces produced:** `ai_agent_fix_watches.subject_kind text NULL`, `.subject_key varchar(200) NULL`; CHECKs `ai_agent_fix_watches_subject_kind_chk`, `ai_agent_fix_watches_subject_shape_chk`; index `ai_agent_fix_watches_subject_idx`.

- [ ] **Step 1: write the migration**

```sql
-- Sweep-condition fix watches (#4442 W02) — spec §3.8.
-- A sweep run has no triggering alert, so a sweep-minted intent could never
-- open a verification episode and was credited `verified` unconditionally on
-- release (intentReleaseWorker.ts:544-570). These two columns give a watch a
-- SUBJECT to re-probe instead of an alert to watch.
--
-- alert_id is ALREADY nullable (2026-09-18-ai-agents-safety-controls.sql:50);
-- nothing here relaxes it.
-- device_id is ALREADY NOT NULL and carries the intent's scope_device_id for
-- these rows; there is deliberately no second device column.
-- source_kind stays 'intent' so recordWatchVerdictEvidence keeps mapping these
-- to namespace 'policy_key' — the namespace the graduation ladder reads.
-- NO DML: an existing watch has subject_kind NULL, which IS the predicate for
-- "alert-anchored", so there is nothing to backfill.

ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS subject_kind text;
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS subject_key  varchar(200);

-- Mirrors AI_SWEEP_KINDS in @breeze/shared. The two must be edited together —
-- same convention as ai_agent_schedules_kinds_chk, and W03 adds
-- 'expiring_certs' to BOTH. (expiring_certs proposes nothing, so it can never
-- reach a watch, but keeping the two value sets equal is what the contract
-- test in Task 6 asserts.)
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_subject_kind_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_subject_kind_chk
  CHECK (subject_kind IS NULL OR subject_kind IN (
    'disk_pressure','stale_agents','pending_reboots','failed_backups',
    'service_down','unpatched_critical'));

-- A subject is a (kind, key) pair or nothing at all. A half-record cannot be
-- probed and would silently grade as `unknown` forever.
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_subject_shape_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_subject_shape_chk
  CHECK ((subject_kind IS NULL) = (subject_key IS NULL));

-- A subject watch is always intent-anchored, so this rides the existing
-- partial intent_id UNIQUE for arbitration; the index below serves the
-- phase-1/phase-2 probe reads and the recurrence lookup by subject.
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_subject_idx
  ON ai_agent_fix_watches (org_id, device_id, subject_kind, subject_key)
  WHERE subject_kind IS NOT NULL;
```

- [ ] **Step 2: Drizzle + export policy.** Add `subjectKind: text('subject_kind').$type<AiSweepKind>()` and `subjectKey: varchar('subject_key', { length: 200 })` to `aiAgentFixWatches`, with a docstring recording the three facts above (alert_id already nullable, device_id is the subject's device, source_kind stays `'intent'`). Add `"subject_kind"` and `"subject_key"` to the `included` array of the `ai_agent_fix_watches` entry in `CORE_TENANT_EXPORT_POLICY` (`:53`). Both are scalars.

- [ ] **Step 3: apply and verify**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run src/db/schema/aiAgentFixWatches.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```

- [ ] **Step 4: commit**

```bash
git commit -m "feat(db): subject columns on ai_agent_fix_watches for sweep-condition verification (#4442)"
```

---

### Task 3: `sweepSubjectProbe.ts` — the three-outcome verification API

**Files:**
- Create: `apps/api/src/services/aiAgents/sweepSubjectProbe.ts`
- Create: `apps/api/src/services/aiAgents/sweepSubjectProbe.test.ts`

**Interfaces:**
- Produces:
```ts
export type SweepSubjectVerdict = 'present' | 'cleared' | 'unknown';

/** One probe per ACT-ELIGIBLE kind. v1 needs exactly one (`service_down`);
 *  the module exists so the next kind cannot skip it. A kind with no probe
 *  registered returns 'unknown' — fail closed, never 'cleared'. */
export async function probeSweepSubject(
  kind: AiSweepKind, orgId: string, deviceId: string, subjectKey: string,
): Promise<SweepSubjectVerdict>;

/** True iff the kind can be act-eligible at all — i.e. it has a probe. W04's
 *  gate reads this; keep it the single source of truth. */
export function isActEligibleSweepKind(kind: AiSweepKind): boolean;
```

- [ ] **Step 1 (RED): write the failing unit tests.** Drive the SQL through the mocked `db.execute` the way `sweepEvidence.test.ts` already does. The cases that matter are the ones that separate this from the loaders:

```ts
it('service_down: the latest result for (device, service) is stopped -> present', …);
it('service_down: the latest result for (device, service) is running -> cleared', …);
it('service_down: no result row inside the freshness window -> unknown, never cleared', …);
it('service_down: the device is offline (last_seen_at older than the staleness bound) -> unknown', …);
it('a kind with no registered probe -> unknown', async () => {
  await expect(probeSweepSubject('failed_backups', ORG, DEV, 'nightly')).resolves.toBe('unknown');
});
it('isActEligibleSweepKind is true only for kinds that have a probe', () => {
  expect(isActEligibleSweepKind('service_down')).toBe(true);
  for (const k of AI_SWEEP_KINDS.filter((x) => x !== 'service_down')) expect(isActEligibleSweepKind(k)).toBe(false);
});
```

- [ ] **Step 2: run to verify it fails.** `cd apps/api && npx vitest run src/services/aiAgents/sweepSubjectProbe.test.ts`.

- [ ] **Step 3: implement.** The module header must say, in these words, why it is not `sweepEvidence.ts`:

> The kind loaders in `sweepEvidence.ts` are fleet-wide, threshold-bearing, `MAX+1` sampling queries built to *find* candidates. They are not verification APIs. `loadFailedBackups` selects the latest **failed** job inside a 7-day window (`sweepEvidence.ts:335-360`), so a later SUCCESS never clears the predicate; `loadServiceDown` filters the whole org. Re-using either to answer "is this one subject still bad?" would report a stale predicate as live, and a predicate merely aging out of a 24-hour window as recovered. Neither is true.

The `service_down` probe, subject-pinned and three-valued:

```sql
SELECT r.status, r.timestamp
FROM service_process_check_results r
JOIN devices d ON d.id = r.device_id
WHERE r.org_id = $1 AND d.org_id = $1
  AND r.device_id = $2 AND r.name = $3
  AND d.is_ephemeral = false
ORDER BY r.timestamp DESC
LIMIT 1
```

Mapping: no row, or `timestamp` older than `SWEEP_PROBE_FRESHNESS_MS` (default 30 min) → `unknown`; `status IN ('stopped','not_found','error')` → `present`; anything else → `cleared`. A thrown query error is caught, `captureException`'d, and returns `unknown` — **never** `cleared`. Note the deliberate asymmetry in the header: `unknown` costs a human review; `cleared` costs a wrong `verified` in the graduation ledger.

Keep the probe registry a `Partial<Record<AiSweepKind, Probe>>` and derive `isActEligibleSweepKind` from it, so adding a kind to `AI_SWEEP_KINDS` (W03) cannot accidentally make it act-eligible.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/sweepSubjectProbe.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): sweepSubjectProbe — three-outcome, subject-pinned condition verification (#4442)"
```

---

### Task 4: `createSweepFixWatchRow` + narrow `watchReleasedIntent`'s fallback

**Files:**
- Modify: `apps/api/src/services/aiAgents/fixWatch.ts` (add beside `createIntentFixWatchRow` at `:318`)
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (`IntentEvidenceAnchor` at `:378`, the anchor build at `:460`, `watchReleasedIntent` at `:544-570`)
- Test: `apps/api/src/services/aiAgents/fixWatch.test.ts` (existing), `apps/api/src/jobs/intentReleaseWorker.test.ts` (existing)

**Interfaces:**
- Produces:
```ts
export interface SweepIntentForWatch {
  intentId: string; orgId: string; runId: string; agentId: string;
  deviceId: string;                 // the intent's scope_device_id
  subjectKind: AiSweepKind;
  subjectKey: string;
  opKey: string;
}
/** Alert-less sibling of createIntentFixWatchRow. Returns the watch id, or
 *  the EXISTING row's id on a conflict — never null for a well-formed input,
 *  because the caller reads null as "nothing will ever verify this". */
export async function createSweepFixWatchRow(
  input: SweepIntentForWatch, database?: WatchDatabase,
): Promise<string | null>;
```
- Produces: `IntentEvidenceAnchor` gains `triggerKind: string | null`, `triggerKey: string | null`, `scopeDeviceId: string | null` (read from the intent row, which the function already has).

- [ ] **Step 1 (RED): failing unit tests**

```ts
// fixWatch.test.ts
it('createSweepFixWatchRow inserts alert_id NULL, rule_id NULL, source_kind intent, the subject pair and the scoped device', …);
it('createSweepFixWatchRow arbitrates on the partial intent_id UNIQUE and returns the existing id on redelivery', …);
it('createSweepFixWatchRow returns null when the org has no resolvable partner (same fail-closed rule as the alert sibling)', …);

// intentReleaseWorker.test.ts
it('a sweep-minted intent opens a sweep watch and writes NO verified row', …);
it('an alert-triggered intent still takes the alert branch, unchanged', …);
it('an intent with neither an alert nor a sweep trigger still credits verified (C4 preserved)', …);
it('a sweep-minted intent whose sweep watch could not be created credits NOTHING — not verified', async () => {
  // The failure mode that would otherwise reintroduce the bug through the back door.
});
```

- [ ] **Step 2: run to verify they fail.** `cd apps/api && npx vitest run src/services/aiAgents/fixWatch src/jobs/intentReleaseWorker` (no trailing slash — this pulls in `fixWatch.test.ts` and `fixWatch.sql.test.ts`; confirm 3+ files ran).

- [ ] **Step 3: implement `createSweepFixWatchRow`.** It is `createIntentFixWatchRow` (`:318-360`) with `loadWatchAnchor` replaced by a bare partner lookup (there is no alert to denormalise from) and the insert taking `alertId: null`, `ruleId: null`, `configItemName: null`, `deviceId: input.deviceId`, `subjectKind`, `subjectKey`, `state: 'pending'`, `sourceKind: 'intent'`, `opKeys: [input.opKey]`. Reuse `insertIntentFixWatchRowQuery` verbatim — the arbiter and its repeated `WHERE intent_id IS NOT NULL` predicate must not be duplicated (a partial unique index cannot be inferred without the predicate; omitting it is a runtime 42P10).

- [ ] **Step 4: implement the `watchReleasedIntent` change.** Insert the sweep arm **between** the alert arm and the unconditional credit, so the fallback is narrowed and not deleted:

```ts
if (anchor.alertId) { /* … unchanged … */ }

// #4442 W02 — a sweep run has no triggering alert, but a sweep FINDING has a
// subject, and a subject can be re-probed. Before this arm existed, every
// sweep-minted intent fell straight through to the `verified` credit below,
// which made P2-5's graduation ladder a click-counter for the whole sweep
// lane (spec §1.1). The fallback still stands for everything else — an
// operation no watch will ever look at must not sit un-gradeable forever (C4).
if (anchor.triggerKind === 'sweep_finding' && anchor.scopeDeviceId && anchor.triggerKey) {
  const subject = parseSweepTriggerKey(anchor.triggerKey);      // 'sweep:<kind>:<subject>'
  if (subject && isActEligibleSweepKind(subject.kind)) {
    const watchId = await createSweepFixWatchRow({ …, deviceId: anchor.scopeDeviceId, ...subject, opKey: anchor.opKey }, tx);
    if (watchId) return watchId;
    // Creation failed for a sweep intent: credit NOTHING and return null.
    // Falling through would write the very `verified` row this wave exists to
    // prevent — a lost verification lane is not a verification.
    return null;
  }
}

await insertOpEvidence([{ …, metric: 'verified', … }], tx);
```

`parseSweepTriggerKey` is a pure export from `sweepSubjectProbe.ts` (or `remediationTrigger.ts` — put it wherever `sweepTriggerKey` from W01 Task 1 lives, so build and parse are inverses and are tested as a round trip). Extend `IntentEvidenceAnchor`'s build (`:460`) to carry `triggerKind` / `triggerKey` / `scopeDeviceId` off the intent row it already holds.

- [ ] **Step 5: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/fixWatch src/jobs/intentReleaseWorker src/services/aiAgents/sweepSubjectProbe
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "fix(ai): sweep-minted intents open a subject watch instead of being credited verified (#4442)"
```

---

### Task 5: Grade a subject watch — phase 1 and phase 2

**Files:**
- Modify: `apps/api/src/services/aiAgents/fixWatch.ts` (`checkFixWatchPhase1` at `:451`, `checkFixWatchPhase2` at `:814`, the recurrence-alert writer at `:658-795`)
- Test: `apps/api/src/services/aiAgents/fixWatch.test.ts` (existing), `apps/api/src/jobs/fixWatchWorker.test.ts` (existing)

**Interfaces:** no new exports. The two phase functions keep their existing return unions (`FixWatchPhase1Outcome`, `FixWatchPhase2Outcome`) so `processFixWatchJob` (`jobs/fixWatchWorker.ts:328-367`) needs **no change** — the re-delay/enqueue/terminal control flow is identical.

- [ ] **Step 1 (RED): failing tests, one per transition**

```ts
// phase 1 — recovery
it('subject watch: probe cleared -> watching, recoveryObservedAt set, dueAt +FIX_HOLD_MINUTES', …);
it('subject watch: probe present -> still_pending (the fix has not taken yet)', …);
it('subject watch: probe unknown -> still_pending, never cancelled and never inconclusive early', …);
it('subject watch: unknown for RECOVERY_TIMEOUT_HOURS -> inconclusive, and NO evidence row', …);
it('alert watch: every existing phase-1 branch is byte-identical', …);

// phase 2 — hold
it('subject watch: probe present after an observed clear -> recurred, one op_evidence row per op_key', …);
it('subject watch: probe cleared -> held_qualified, one `verified` op_evidence row', …);
it('subject watch: probe unknown -> inconclusive, NO evidence row (never `failed`)', …);
it('a recurred subject watch auto-demotes the colon key exactly as a recurred alert watch does', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement.** Both functions branch on `watch.subjectKind !== null` at the top of the loaded-row block and take a probe verdict where they would have read `alerts.status`:

| | alert watch (unchanged) | subject watch (new) |
|---|---|---|
| phase 1 recovery | `alertStatus === 'resolved'` | `probe === 'cleared'` |
| phase 1 cancel | `alertStatus === 'dismissed'` | *(no cancel path — there is no human to dismiss a condition)* |
| phase 1 keep waiting | active/ack/suppressed/missing | `present` or `unknown` |
| phase 1 give up | age ≥ `RECOVERY_TIMEOUT_HOURS` → `inconclusive` | same |
| phase 2 recurrence | a matching alert after `recovery_observed_at` | `probe === 'present'` |
| phase 2 hold | no matching alert | `probe === 'cleared'` |
| phase 2 inconclusive | — | `probe === 'unknown'` → `inconclusive`, no evidence |

`recordWatchVerdictEvidence` (`:544`) needs **no change**: a subject watch is `source_kind: 'intent'` with one colon `op_key`, so it already maps to `namespace: 'policy_key'` and writes `verified` / `recurred` on the right source id.

Phase 2's operator-facing recurrence alert (`FIX_WATCH_ALERT_CONFIG_ITEM`, `:658`) currently dedupes on `context->>'recurrenceAlertId'`. A subject recurrence has no recurrence alert id — dedupe on `context->>'runId' = watch.runId AND context->>'watchId' = watch.id` instead for these rows, and set the message to name the subject (`"…the condition service_down:MSSQLSERVER returned within 60 minutes"`). `recurrenceAlertId` stays NULL on the watch row.

One thing phase 2 must NOT do: `checkFixWatchPhase2`'s existing early return is `if (!watch || watch.state !== 'watching' || !watch.recoveryObservedAt) return null;`. Leave it. A subject watch reaches `watching` only through phase 1's `cleared` branch, which sets `recoveryObservedAt` — the invariant is the same.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/fixWatch src/jobs/fixWatchWorker
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): grade subject-anchored fix watches by re-probing the sweep condition (#4442)"
```

---

### Task 6: Live-DB suites, the control goes green, PR

**Files:**
- Modify: `apps/api/src/__tests__/integration/sweepIntentVerification.integration.test.ts` (extend, do not rewrite)
- Create: `apps/api/src/db/schema/aiAgentFixWatches.subjectKinds.test.ts`

- [ ] **Step 1: kinds-parity contract test (unit, Test API job).** The CHECK's value set must equal `AI_SWEEP_KINDS`, the same contract `aiAgentSchedulesPartnerRls.integration.test.ts:455-478` enforces for the schedules table — but assert it here at unit level by parsing the migration file, so W03 adding a 7th kind reds in **Test API** and not two jobs later:

```ts
it('ai_agent_fix_watches_subject_kind_chk names exactly AI_SWEEP_KINDS', () => { /* parse the .sql, compare sets both ways */ });
```

- [ ] **Step 2: extend the control test to the full episode.** Add, against the live DB: probe returns cleared → phase 1 moves the watch to `watching`; phase 2 with cleared → `held_qualified` **and** exactly one `ai_agent_op_evidence` row `(source_kind='watch', metric='verified', namespace='policy_key')`; phase 2 with present → `recurred` plus the auto-demote. Also assert the one-watch-per-intent invariant directly: two `createSweepFixWatchRow` calls for the same intent leave exactly one row.

- [ ] **Step 3: run every live-DB suite this wave can redden**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/sweepIntentVerification.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api test --run
pnpm test-stack down
```

- [ ] **Step 4: open the PR.** Body must carry: the Task 1 red output and the same test now green; the statement that `alert_id` was already nullable and nothing was relaxed; that `source_kind` was deliberately **not** extended; that P2-5's C4 fallback is narrowed, not removed, with the regression case named; and `Closes #<wave sub-issue>`. If stacked, `gh workflow run CI --ref <branch>`.
