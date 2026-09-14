---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (W04 sub-issue)
branch: feature/<parent>-ai-scorecard/wave-<sub-issue>
---

# AI Scorecard W04 — Measured impact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the hub first:** [`2026-09-13-ai-scorecard.md`](./2026-09-13-ai-scorecard.md). Its *Global Constraints* section is part of every task below.
> **Independent of W01, W02 and W03.** Branch off `main`.

**Goal:** Put a **measured** band beside P2-6's estimated one on `/ai-agents/impact` — a correlational, honestly-labelled comparison of what happened to AI-touched work versus untouched work of the same kind, computed at read time from data that already exists.

**Architecture:** No new table. A read-time service `services/aiAgents/impactMeasured.ts` (SQL in a sibling `impactMeasuredCohorts.ts`, statistics in a pure `impactStatistics.ts`) forms cohorts **by exposure time, not by linkage**: an item enters the AI arm only if the earliest AI contact with it — a verdict's `created_at`, directly or via correlation-group membership, or a run's `started_at` — precedes the outcome being measured, and only among items still open at a prespecified exposure age *L*. The primary statistic is the **proportion resolved/responded within horizon *H***; Kaplan–Meier right-censored p50/p90 are a refinement emitted only when estimable. Four cohort indexes are added. The measured band gets its own endpoint and its own authorization decision — it is **not** inherited from `/ai-agents/impact`'s `ai_agents:read`. `ImpactPage.tsx` (1014 lines) splits into an estimate band and a measured band.

**Tech Stack:** Hono, Drizzle (raw `sql` for the cohort CTEs), PostgreSQL 16, Zod in `packages/shared`, Vitest (pure-unit for the statistics, integration for every query), React + recharts + react-i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-scorecard-attribution-and-impact-design.md` §3.6, §3.7, OD-4 A, OD-5 A, OD-6 A.

**Tracking:** feature TBD, wave TBD. Branch off `main`. One PR, body `Closes #<wave sub-issue>` and `Refs #4182`.

## Global Constraints

Hub *Global Constraints* apply. W04-specific additions — **most of these are the difference between a number that is true and one that flatters the AI**:

- Migration filename **`apps/api/migrations/2026-10-16-181720-impact-measured-indexes.sql`**. Indexes only, no DML, no `breeze.scope` elevation, no baseline entry.
- **90-day hard cap.** `window ∈ {7, 30, 90}` exactly as P2-6 (`AI_AGENT_IMPACT_WINDOWS`, `packages/shared/src/types/aiAgentImpact.ts:11`). `through` is always the **last complete UTC day**, computed server-side by `lastCompleteUtcDay()` (`services/aiAgents/impactRollup.ts:94-98`) — never client-supplied. Note the existing endpoint accepts only `window` and a singular optional `orgId` (`packages/shared/src/validators/aiAgentImpact.ts:35-38`); the measured endpoint matches that surface.
- **The timestamp trap is real and must be pinned by a test.** `alerts.triggered_at` / `resolved_at` (`db/schema/alerts.ts:113`, `:115`) and every `tickets` date column (`db/schema/portal.ts:141-143`, `:168`) are plain `timestamp` **without** time zone. `ai_alert_verdicts.created_at` (`db/schema/aiAlertVerdicts.ts:37`) and `ai_agent_runs.queued_at`/`started_at`/`finished_at` (`db/schema/aiAgents.ts:146-148`) **are** `timestamptz`. P2-6's SQL operates on `timestamptz`; copying its `AT TIME ZONE 'UTC'` casts blindly onto an alert column shifts the bound. **Rule:** bound a naive column with `>= ${fromDay}::date::timestamp` / `< (${toDay}::date + 1)::timestamp` (no `AT TIME ZONE`); convert a `timestamptz` to the comparable naive UTC instant with `(x AT TIME ZONE 'UTC')` before comparing it to a naive column. Task 3 pins this with a test that a verdict written at 23:30 UTC is not sorted into the wrong day.
- **`ai_agent_runs` has no `created_at`.** Use `started_at` for exposure (and fall back to `queued_at` only where a run never started — a never-started run is not exposure and should be excluded; say so in the query comment).
- **`sla_compliance` is not a source.** `db/schema/analytics.ts:240-258` declares `response_time_actual` and `resolution_time_actual`, and a repo-wide grep finds **no writer at all** — every reference is a read (`routes/analytics.ts:1692-1694`, `services/aiToolsAnalytics.ts:171-206`). Anything reading them would report zeros as fact.
- **Never called "before/after", never called causal.** "AI-touched vs untouched in one window" is a contemporaneous comparison, not a time-series break. The selection bias is named in the UI copy: *the AI triages the easy items first.* This is the same discipline P2-6 applies when it forbids calling a thumbs-up "precision".
- **`n < 20` per arm ⇒ no number for that cohort.** This is a display gate, not a substitute for correct cohort formation. At n = 20 the upper decile holds about two observations, so p90 is reported with its cohort size or not at all.
- **Uncensored resolved-only percentiles are forbidden as a headline.** Conditioning on completion biases the two arms differently. Ship the proportion-within-*H* as primary; KM p50/p90 as an explicitly-labelled refinement.
- **Authorization is a new decision, not an inheritance** (spec §3.6, OD-5). See Task 6 — a system-context read to get around the time-entry restrictions would be the #2417 anti-pattern.
- Every read applies `auth.orgCondition(...)` **even though RLS enforces**, exactly as P2-6 does (`services/aiAgents/impactQuery.ts:171`, `:182`): partner scope means *accessible* orgs, not automatically every org under the partner.
- **Do not build the window bounds as a CTE.** P2-6 learned this: a `bounds` CTE referenced by sibling CTEs is materialized, the range predicates stop being constant-folded, and the index range scans this wave adds are lost. Inline the cast expressions in every predicate.
- Every task ends with the API typecheck (or `astro check`), its targeted vitest run, and a commit.

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types/aiAgentImpactMeasured.ts` (create) | the DTO, the constants, the omission reasons |
| `packages/shared/src/validators/aiAgentImpactMeasured.ts` (create) | the query schema |
| `apps/api/src/services/aiAgents/impactStatistics.ts` (create) | pure: proportion-within-H, Kaplan–Meier quantiles, the n-gate |
| `apps/api/src/services/aiAgents/impactMeasuredCohorts.ts` (create) | the three cohort SQL builders |
| `apps/api/src/services/aiAgents/impactMeasured.ts` (create) | authorization, orchestration, DTO assembly |
| `apps/api/migrations/2026-10-16-181720-impact-measured-indexes.sql` (create) | four cohort indexes |
| `apps/api/src/routes/aiAgents.ts` (modify, near `:1552`) | `GET /impact/measured` |
| `apps/web/src/components/aiAgents/ImpactEstimateBand.tsx` (create) | lines ~717-1013 of today's `ImpactPage.tsx` |
| `apps/web/src/components/aiAgents/ImpactMeasuredBand.tsx` (create) | the new band |
| `apps/web/src/components/aiAgents/ImpactPage.tsx` (modify) | host: header, window selector, weights drawer, both bands |

---

### Task 1: The measured DTO, the constants, and the omission vocabulary

**Files:**
- Create: `packages/shared/src/types/aiAgentImpactMeasured.ts`
- Create: `packages/shared/src/validators/aiAgentImpactMeasured.ts`
- Create: `packages/shared/src/types/aiAgentImpactMeasured.test.ts`
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/validators/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MEASURED_MIN_COHORT_N = 20;
  export const MEASURED_MAX_WINDOW_DAYS = 90;
  /** Cohort-formation age. MUST exceed UNGROUPED_VERDICT_DELAY_MINUTES (=10). */
  export const ALERT_EXPOSURE_AGE_MINUTES = 15;
  export const ALERT_OUTCOME_HORIZON_HOURS = 24;
  export const TICKET_EXPOSURE_AGE_MINUTES = 15;
  export const TICKET_RESPONSE_HORIZON_HOURS = 4;

  export type MeasuredOmissionReason =
    | 'insufficient_data'        // n < MEASURED_MIN_COHORT_N in one or both arms
    | 'insufficient_followup'    // the window does not contain L + H for enough items
    | 'insufficient_authority'   // caller lacks the time-entry permission / partner scope
    | 'site_restricted';         // caller's site scope is not unrestricted

  export interface MeasuredArm {
    n: number;
    /** PRIMARY statistic: share of the arm that reached the outcome within H. */
    proportionWithinHorizon: number;
    /** Refinement. Right-censored (Kaplan-Meier). null when not estimable. */
    censoredP50Minutes: number | null;
    censoredP90Minutes: number | null;
  }
  export interface MeasuredCohort {
    key: string;                 // rule id, or "priority|category"
    label: string;
    aiTouched: MeasuredArm;
    untouched: MeasuredArm;
  }
  export interface MeasuredSignal {
    cohorts: MeasuredCohort[];
    omitted: MeasuredOmissionReason | null;
    exposureAgeMinutes: number;
    horizonHours: number;
  }
  export interface AiAgentImpactMeasuredDto {
    schemaVersion: 1;
    window: 7 | 30 | 90;
    from: string;                // UTC day
    through: string;             // last COMPLETE UTC day
    alertResolution: MeasuredSignal;
    ticketFirstResponse: MeasuredSignal;
    technicianMinutes:
      | { omitted: MeasuredOmissionReason }
      | { omitted: null; cohorts: TechnicianMinutesCohort[]; loggingCoverage: { aiTouched: number; untouched: number } };
  }
  export interface TechnicianMinutesCohort {
    key: string; label: string;
    aiTouched: { n: number; medianRecordedMinutes: number | null };
    untouched: { n: number; medianRecordedMinutes: number | null };
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { ALERT_EXPOSURE_AGE_MINUTES, MEASURED_MIN_COHORT_N, MEASURED_MAX_WINDOW_DAYS } from './aiAgentImpactMeasured';
import { UNGROUPED_VERDICT_DELAY_MINUTES } from '???'; // see note

it('the cohort-formation age exceeds the scheduler delay before any AI analysis starts', () => {
  // jobs/alertVerdictScheduler.ts:79 -- an alert must stay open and uncorrelated
  // for 10 minutes before it gets its own verdict run. If L <= that, the AI arm
  // is systematically empty and the comparison is vacuous.
  expect(ALERT_EXPOSURE_AGE_MINUTES).toBeGreaterThan(10);
});

it('pins the display gate and the window cap', () => {
  expect(MEASURED_MIN_COHORT_N).toBe(20);
  expect(MEASURED_MAX_WINDOW_DAYS).toBe(90);
});

it('the query schema accepts only the three P2-6 windows', () => {
  expect(impactMeasuredQuerySchema.safeParse({ window: 90 }).success).toBe(true);
  expect(impactMeasuredQuerySchema.safeParse({ window: 180 }).success).toBe(false);
  expect(impactMeasuredQuerySchema.safeParse({ window: 30, through: '2026-01-01' }).success).toBe(false);
});
```

> **Note on the cross-package constant:** `UNGROUPED_VERDICT_DELAY_MINUTES` lives in `apps/api/src/jobs/alertVerdictScheduler.ts:79` and `packages/shared` must not import from `apps/api`. Assert the literal `10` here with the file:line in the comment, **and** add the real cross-check in `apps/api` (Task 4's contract test) where both symbols are importable.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/aiAgentImpactMeasured.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the types, constants and Zod schema** exactly as in the Interfaces block. `impactMeasuredQuerySchema = z.object({ window: z.coerce.number().refine(isAiAgentImpactWindow), orgId: z.string().uuid().optional() }).strict()` — `.strict()` so a client cannot smuggle a `through`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/types/aiAgentImpactMeasured.test.ts && npx tsc --noEmit
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(ai): measured-impact DTO, cohort constants and query schema"
```

---

### Task 2: The statistics module — proportion within H, censored quantiles, the n-gate

**Files:**
- Create: `apps/api/src/services/aiAgents/impactStatistics.ts`
- Create: `apps/api/src/services/aiAgents/impactStatistics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** One observed item: minutes to outcome, and whether the outcome was OBSERVED. */
  export interface Observation { minutes: number; observed: boolean }  // observed=false ⇒ right-censored at `minutes`
  export function proportionWithinHorizon(obs: readonly Observation[], horizonMinutes: number): number;
  /** Kaplan-Meier survival; returns null for a quantile the data cannot reach. */
  export function kaplanMeierQuantile(obs: readonly Observation[], q: number): number | null;
  export function buildArm(obs: readonly Observation[], horizonMinutes: number): MeasuredArm | null; // null when n < 20
  ```

**Why this module is pure and separately tested.** Cohort SQL can only be tested against a live database, which is slow and hides arithmetic mistakes inside seed-data noise. The statistic itself is arithmetic and belongs in a fast unit test with hand-computed expectations.

- [ ] **Step 1: Write the failing test**

```ts
describe('proportionWithinHorizon', () => {
  it('counts only OBSERVED outcomes inside the horizon', () => {
    const obs = [
      { minutes: 10, observed: true },    // in
      { minutes: 30, observed: true },    // in
      { minutes: 90, observed: true },    // out (past horizon)
      { minutes: 20, observed: false },   // censored at 20 -- NOT a success
    ];
    expect(proportionWithinHorizon(obs, 60)).toBeCloseTo(2 / 4);
  });

  it('is 0, not NaN, for an empty arm', () => {
    expect(proportionWithinHorizon([], 60)).toBe(0);
  });
});

describe('kaplanMeierQuantile', () => {
  it('matches a hand-computed median with no censoring', () => {
    const obs = [10, 20, 30, 40, 50].map((m) => ({ minutes: m, observed: true }));
    expect(kaplanMeierQuantile(obs, 0.5)).toBe(30);
  });

  it('returns null when survival never drops to the quantile', () => {
    // 90% censored early: S(t) never reaches 0.5
    const obs = [{ minutes: 5, observed: true }, ...Array(19).fill({ minutes: 6, observed: false })];
    expect(kaplanMeierQuantile(obs, 0.5)).toBeNull();
  });

  it('a censored observation does NOT count as a resolution', () => {
    const allCensored = Array(30).fill({ minutes: 10, observed: false });
    expect(kaplanMeierQuantile(allCensored, 0.5)).toBeNull();
  });

  it('censoring RAISES the estimate versus dropping the censored rows', () => {
    // The whole reason we censor: dropping still-open items biases the arm fast.
    const withCensored = [
      ...[10, 20].map((m) => ({ minutes: m, observed: true })),
      ...Array(8).fill({ minutes: 25, observed: false }),
    ];
    const droppingThem = [10, 20].map((m) => ({ minutes: m, observed: true }));
    const km = kaplanMeierQuantile(withCensored, 0.5);
    const naive = kaplanMeierQuantile(droppingThem, 0.5);
    expect(km === null || km >= naive!).toBe(true);
  });
});

describe('buildArm', () => {
  it('returns null below the display gate of 20', () => {
    expect(buildArm(Array(19).fill({ minutes: 5, observed: true }), 60)).toBeNull();
  });
  it('returns an arm at exactly 20', () => {
    expect(buildArm(Array(20).fill({ minutes: 5, observed: true }), 60)).toMatchObject({ n: 20 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/impactStatistics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** — a standard Kaplan–Meier product-limit estimator: sort ascending, at each distinct event time `t` with `d` events among `n` at risk multiply `S *= (1 - d/n)`; the quantile is the smallest `t` with `S(t) <= 1 - q`; return `null` if `S` never gets there.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiAgents/impactStatistics.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/impactStatistics.ts apps/api/src/services/aiAgents/impactStatistics.test.ts
git commit -m "feat(ai): pure statistics for measured impact (proportion within horizon, censored quantiles)"
```

---

### Task 3: Migration — the four cohort indexes

**Files:**
- Create: `apps/api/migrations/2026-10-16-181720-impact-measured-indexes.sql`
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`

**Index inventory (verified against `main` — do not add one that already exists):**

| Index | Why it is needed | What already exists |
|---|---|---|
| `alerts_org_rule_triggered_idx (org_id, rule_id, triggered_at)` | the alert cohort scans one org, one rule, one window | `alerts_org_status_triggered_at_idx (org_id, status, triggered_at DESC)` and `alerts_rule_id_idx (rule_id)` — neither serves (org, rule, time) |
| `tickets_org_created_at_idx (org_id, created_at)` | the ticket cohort scans one org over a window of `created_at` | `tickets_org_status_idx`, `tickets_org_work_kind_idx` — no `created_at` leading pair |
| `ai_agent_runs_org_alert_started_idx (org_id, alert_id, started_at) WHERE alert_id IS NOT NULL` | run-based alert exposure | only `ai_agent_runs_device_id_idx`, `_ticket_id_idx`, `_org_queued_idx` |
| `ai_agent_runs_org_ticket_started_idx (org_id, ticket_id, started_at) WHERE ticket_id IS NOT NULL` | run-based ticket exposure | `ai_agent_runs_ticket_id_idx (ticket_id)` alone forces a heap re-check per org |

**Deliberately NOT added:** `ai_alert_verdicts` already has `ai_alert_verdicts_org_alert_idx (org_id, alert_id) WHERE alert_id IS NOT NULL` and `_org_group_idx (org_id, correlation_group_id) WHERE correlation_group_id IS NOT NULL` (`db/schema/aiAlertVerdicts.ts:54-55`); a `MIN(created_at)` over the handful of verdicts for one alert does not justify a superset index. `alert_correlation_members` already has `_org_alert_idx` and `_org_group_idx` (`db/schema/alerts.ts:186-187`). `time_entries_ticket_idx` and `ticket_drafts_ticket_idx` already exist.

- [ ] **Step 1: Write the failing test**

```ts
it('the measured-impact index migration is present and sorts last', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
  expect(files).toContain('2026-10-16-181720-impact-measured-indexes.sql');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the migration** — four `CREATE INDEX IF NOT EXISTS` statements with the table above's reasoning as comments. No DML. Mirror all four into the Drizzle schema files in the same commit so `pnpm db:check-drift` stays clean.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
pnpm test-stack up && pnpm db:migrate && pnpm db:migrate && pnpm db:check-drift
```
Expected: PASS, second migrate a no-op, no drift.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-16-181720-impact-measured-indexes.sql apps/api/src/db/schema apps/api/src/db/autoMigrate.test.ts
git commit -m "feat(ai): cohort indexes for measured impact"
```

---

### Task 4: Exposure time — the cohort predicate that kills reverse temporal attribution

**Files:**
- Create: `apps/api/src/services/aiAgents/impactMeasuredCohorts.ts` (the alert exposure CTE)
- Create: `apps/api/src/__tests__/integration/impactMeasuredExposure.integration.test.ts`
- Create: `apps/api/src/services/aiAgents/impactMeasured.contract.test.ts`

**Interfaces:**
- Produces: `export function alertExposureCte(orgIds: readonly string[], from: string, through: string): SQL` — one row per alert, `(alert_id, exposure_at)` where `exposure_at` is the **earliest** AI contact, deduplicated across the direct and group paths.

**The three defects this closes (all verified on `main`):**

1. **Reverse temporal attribution.** `jobs/alertVerdictScheduler.ts:79` sets `UNGROUPED_VERDICT_DELAY_MINUTES = 10`: an alert must stay open and uncorrelated for ten minutes before it gets its own verdict run. So an alert that self-resolves in five minutes and is *then* analysed would enter a linkage-based "AI-touched" cohort with a five-minute MTTR — the AI credited for an outcome that completed before it looked. Identically on tickets: `services/aiAgents/ticketHelpdeskSubscriber.ts:439` returns unless `toStatus === 'resolved'`, so an `ai_agent_runs.ticket_id` link is **no evidence** of involvement before first response.
2. **Group verdicts are invisible to a direct link.** Correlation-group verdicts carry `alert_id = NULL` by design (`services/aiAgents/alertVerdicts.ts:358`: `alertId: run.correlationGroupId ? null : run.alertId`), so a `WHERE v.alert_id = a.id` predicate silently drops them. Membership is `alert_correlation_members` (`db/schema/alerts.ts:174-188`), traversed at `alertVerdicts.ts:545`.
3. **Resolved-only percentiles omit still-open cases** and bias the two arms differently.

**The predicate:**

```
exposure_at(A) = MIN over the UNION of:
    v.created_at        for ai_alert_verdicts v WHERE v.org_id = A.org_id AND v.alert_id = A.id
    v.created_at        for ai_alert_verdicts v
                          JOIN alert_correlation_members m ON m.group_id = v.correlation_group_id
                          WHERE m.org_id = A.org_id AND m.alert_id = A.id
    r.started_at        for ai_agent_runs r WHERE r.org_id = A.org_id AND r.alert_id = A.id
                          AND r.started_at IS NOT NULL   -- a never-started run is not exposure

Cohort membership (both arms): A.resolved_at IS NULL OR A.resolved_at >= A.triggered_at + L
AI arm:        exposure_at IS NOT NULL AND exposure_at <= A.triggered_at + L
Untouched arm: exposure_at IS NULL OR exposure_at > A.triggered_at + L
```

Cohorts are formed **within one rule**, one org, one window — comparing all AI-touched to all untouched would measure which items the AI *chose*. Follow the existing rollup's precedent of demanding more than a link (`impactRollup.ts:190-200` already requires a qualifying profile, status, absence of error, and an outcome).

**Timestamp normalization (the trap):** `alerts.triggered_at` / `resolved_at` are naive; `ai_alert_verdicts.created_at` and `ai_agent_runs.started_at` are `timestamptz`. Every comparison converts the latter with `(x AT TIME ZONE 'UTC')`. Window bounds on `alerts.triggered_at` use `>= ${from}::date::timestamp` / `< (${through}::date + 1)::timestamp` with **no** `AT TIME ZONE` — the opposite of P2-6's shape, because P2-6's columns are `timestamptz`.

- [ ] **Step 1: Write the failing tests**

`impactMeasured.contract.test.ts` (unit, no DB):

```ts
import { UNGROUPED_VERDICT_DELAY_MINUTES } from '../../jobs/alertVerdictScheduler';
import { ALERT_EXPOSURE_AGE_MINUTES } from '@breeze/shared';

it('L exceeds the scheduler delay, so the AI arm is reachable at all', () => {
  expect(ALERT_EXPOSURE_AGE_MINUTES).toBeGreaterThan(UNGROUPED_VERDICT_DELAY_MINUTES);
});

it('the exposure CTE traverses correlation-group membership, not just the direct link', () => {
  const sqlText = String(alertExposureCte(['org-1'], '2026-01-01', '2026-01-31'));
  expect(sqlText).toContain('alert_correlation_members');
});

it('does not apply AT TIME ZONE to the naive alerts columns', () => {
  const sqlText = String(alertExposureCte(['org-1'], '2026-01-01', '2026-01-31'));
  expect(sqlText).not.toMatch(/triggered_at\s+AT TIME ZONE/);
  expect(sqlText).not.toMatch(/resolved_at\s+AT TIME ZONE/);
});
```

`impactMeasuredExposure.integration.test.ts` (real Postgres):

```ts
it('EXCLUDES a self-resolving alert that was analysed afterwards', async () => {
  // resolved at +5 min; verdict written at +11 min (the scheduler's own delay)
  const rows = await loadAlertExposure(ORG, FROM, THROUGH);
  expect(rows.find((r) => r.alertId === SELF_RESOLVED)).toBeUndefined(); // not in the cohort at all
});

it('INCLUDES a group-verdict alert exactly once, even though the verdict has alert_id NULL', async () => {
  const rows = await loadAlertExposure(ORG, FROM, THROUGH);
  const hits = rows.filter((r) => r.alertId === GROUPED_ALERT);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.exposureAt).toEqual(GROUP_VERDICT_CREATED_AT);
});

it('takes the EARLIEST contact when an alert has both a direct verdict and a group verdict', async () => {
  const rows = await loadAlertExposure(ORG, FROM, THROUGH);
  expect(rows.find((r) => r.alertId === BOTH)!.exposureAt).toEqual(EARLIER_OF_THE_TWO);
});

it('ignores a run that never started', async () => {
  const rows = await loadAlertExposure(ORG, FROM, THROUGH);
  expect(rows.find((r) => r.alertId === QUEUED_ONLY_RUN)).toBeUndefined();
});

it('does not shift a 23:30 UTC verdict into the next day (timestamp vs timestamptz)', async () => {
  const rows = await loadAlertExposure(ORG, DAY, DAY);
  expect(rows.find((r) => r.alertId === LATE_NIGHT)).toBeDefined();
});

it('never crosses an org boundary', async () => {
  const rows = await loadAlertExposure(ORG_A, FROM, THROUGH);
  expect(rows.some((r) => r.orgId === ORG_B)).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd apps/api && npx vitest run src/services/aiAgents/impactMeasured.contract.test.ts
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/impactMeasuredExposure.integration.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** per the predicate above, with the three defects named in comments so nobody "simplifies" it back to a linkage join.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiAgents/impactMeasured.contract.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/impactMeasuredExposure.integration.test.ts
```
Expected: PASS, 3 + 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/impactMeasuredCohorts.ts apps/api/src/services/aiAgents/impactMeasured.contract.test.ts apps/api/src/__tests__/integration/impactMeasuredExposure.integration.test.ts
git commit -m "feat(ai): exposure-time cohort predicate for measured impact"
```

---

### Task 5: The alert-resolution and ticket-first-response signals

**Files:**
- Modify: `apps/api/src/services/aiAgents/impactMeasuredCohorts.ts`
- Modify: `apps/api/src/__tests__/integration/impactMeasuredExposure.integration.test.ts` (or a sibling `impactMeasuredSignals.integration.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export async function loadAlertResolutionSignal(auth: AuthContext, w: MeasuredWindow): Promise<MeasuredSignal>;
  export async function loadTicketFirstResponseSignal(auth: AuthContext, w: MeasuredWindow): Promise<MeasuredSignal>;
  ```

**Alert resolution.** Cohort key = `alerts.rule_id`. Outcome minutes = `resolved_at − (triggered_at + L)`, observed when `resolved_at IS NOT NULL AND resolved_at <= through_bound`; otherwise right-censored at `min(through_bound, now) − (triggered_at + L)`. `alerts.status` is `('active','acknowledged','resolved','suppressed','dismissed')` (`db/schema/alerts.ts:25`) — **`suppressed` and `dismissed` are not resolutions**; treat them as censored at the status change if a timestamp exists, else exclude, and say which in the comment. Only alerts with `triggered_at + L + H <= through_bound` are eligible (enough follow-up), otherwise the signal reports `insufficient_followup`.

**Ticket first response.** Cohort key = `priority || '|' || COALESCE(category, '')` (`db/schema/portal.ts:134`, `:132`). Exposure = `MIN(ai_agent_runs.started_at)` for runs with `ticket_id = T`, unioned with `ticket_drafts.created_at` for drafts on `T`. Cohort membership: `first_response_at IS NULL OR first_response_at >= created_at + L`. Outcome minutes = `first_response_at − (created_at + L)`, observed when non-null and within the bound, else censored. H = `TICKET_RESPONSE_HORIZON_HOURS` (4). Soft-deleted tickets are excluded (`tickets_deleted_at_idx` exists precisely because `deleted_at` is a live filter).

The existing aggregate precedent to follow for shape is `services/portal/ticketReadModel.ts:116-131` (`avg(extract(epoch from (first_response_at - created_at)) / 60)` with a `count(*)::int` sample size).

Both signals apply `auth.orgCondition(...)` on the primary table even though RLS enforces.

- [ ] **Step 1: Write the failing test**

```ts
it('an alert resolved after AI exposure lands in the AI arm; an untouched sibling of the same rule lands in the other', async () => {
  const sig = await loadAlertResolutionSignal(auth, W90);
  const c = sig.cohorts.find((x) => x.key === RULE_A)!;
  expect(c.aiTouched.n).toBe(25);
  expect(c.untouched.n).toBe(25);
});

it('omits a rule whose smaller arm is below 20', async () => {
  const sig = await loadAlertResolutionSignal(auth, W90);
  expect(sig.cohorts.find((x) => x.key === RULE_SPARSE)).toBeUndefined();
});

it('reports insufficient_data rather than an empty band when NO rule qualifies', async () => {
  const sig = await loadAlertResolutionSignal(authForEmptyOrg, W90);
  expect(sig).toMatchObject({ cohorts: [], omitted: 'insufficient_data' });
});

it('counts a still-open alert as censored, not as a non-resolution dropped from the arm', async () => {
  const sig = await loadAlertResolutionSignal(auth, W90);
  const c = sig.cohorts.find((x) => x.key === RULE_WITH_OPEN)!;
  expect(c.aiTouched.n).toBe(EXPECTED_INCLUDING_OPEN);
  expect(c.aiTouched.proportionWithinHorizon).toBeLessThan(1);
});

it('does not treat a suppressed alert as resolved', async () => {
  // Seed 25 AI-exposed alerts on RULE_B that end status='suppressed' with
  // resolved_at NULL. Assert proportionWithinHorizon for that arm is 0 — a
  // suppression is not an outcome, and counting it would make noise
  // suppression look like resolution.
  const sig = await loadAlertResolutionSignal(auth, W90);
  expect(sig.cohorts.find((x) => x.key === RULE_B)!.aiTouched.proportionWithinHorizon).toBe(0);
});

it('a resolved-ticket-triggered AI run does NOT put the ticket in the AI arm for first response', async () => {
  // ticketHelpdeskSubscriber.ts:439 fires on toStatus==='resolved', long after
  // first response. Exposure time, not linkage, is what excludes it.
  const sig = await loadTicketFirstResponseSignal(auth, W90);
  const c = sig.cohorts.find((x) => x.key === 'high|billing')!;
  expect(c.untouched.n).toBeGreaterThan(0);
  expect(c.aiTouched.n).toBe(0);       // …or the cohort is omitted; assert whichever the seed implies
});

it('excludes soft-deleted tickets', async () => {
  // Seed 25 qualifying tickets in one cohort, then soft-delete 5 of them
  // (deleted_at set). Assert the arm sizes sum to 20, not 25 — `deleted_at` is
  // a live filter everywhere else (tickets_deleted_at_idx exists for it).
  const sig = await loadTicketFirstResponseSignal(auth, W90);
  const c = sig.cohorts.find((x) => x.key === COHORT_WITH_DELETED);
  expect((c?.aiTouched.n ?? 0) + (c?.untouched.n ?? 0)).toBe(20);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/impactMeasuredSignals.integration.test.ts
```
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write the implementation.** Return `Observation[]` per arm from SQL and run `buildArm` (Task 2) in TypeScript — do **not** attempt Kaplan–Meier in SQL. Inline every bound cast; no `bounds` CTE.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/impactMeasuredSignals.integration.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/impactMeasuredCohorts.ts apps/api/src/__tests__/integration/impactMeasuredSignals.integration.test.ts
git commit -m "feat(ai): alert-resolution and ticket-first-response measured signals"
```

---

### Task 6: Technician minutes — a separate authorization decision, and coverage published alongside

**Files:**
- Modify: `apps/api/src/services/aiAgents/impactMeasuredCohorts.ts`
- Create: `apps/api/src/services/aiAgents/impactMeasured.ts` (authorization + orchestration)
- Create: `apps/api/src/services/aiAgents/impactMeasured.test.ts`

**Interfaces:**
- Produces: `export async function loadMeasuredImpact(auth: AuthContext, input: { window: 7|30|90; orgId?: string }): Promise<AiAgentImpactMeasuredDto>`.

**The authorization rules — this is the part a hurried implementation gets wrong.**

1. **Site scope.** Existing impact filtering is organizational (`services/aiAgents/impactQuery.ts:171`), but run visibility treats site authority as an additional boundary (`services/aiAgentRunSiteScope.ts:18`, `runSiteScopeCondition`). W04 requires **unrestricted site scope** (`auth.allowedSiteIds === undefined`) for the whole measured band in its first release rather than inventing scoped aggregation under time pressure. Otherwise every signal is `omitted: 'site_restricted'`.
2. **Time entries are a separate permission, not an inheritance.** `/ai-agents/impact` requires `requireAiRead` (`routes/aiAgents.ts:1552`). `time_entries` deliberately requires **partner or system scope** (`routes/timeEntries/timeEntries.ts:23`: `requireScope('partner', 'system')`) plus a `time_entries` permission, and an ordinary standalone read is limited to the caller's *own* entries unless `actor.manageAll` (`:205-211`). Publishing org-wide labour comparisons on the impact page is therefore a **new** authorization decision. The technician-minutes arm requires the caller to hold the time-entry permission **and** partner scope; otherwise that arm alone is `omitted: 'insufficient_authority'` while alert-resolution and ticket-first-response still render.
3. **Never reach for a system context to get around (2).** `runOutsideDbContext(() => withSystemDbAccessContext(...))` here would bypass RLS entirely and is exactly the anti-pattern that shipped a cross-tenant hole in #2417. It also double-holds a pooled connection under the request's own transaction. The correct answer to "the caller cannot see time entries" is to omit the arm.
4. `time_entries` is **partner-axis** (`partner_id NOT NULL`, `org_id` **nullable**; `PARTNER_TENANT_TABLES` at `rls-coverage.integration.test.ts:202`, and it is in `ORG_AXIS_POLICY_EXCLUDED_TABLES` at `:135`). Join it to `tickets` on `ticket_id` and scope the *tickets* side by `auth.orgCondition(tickets.orgId)`; do **not** try to filter `time_entries.org_id`, which may legitimately be NULL.

**The metric.** *Recorded* technician minutes per ticket: aggregate `SUM(duration_minutes)` per ticket first (a running timer has `duration_minutes` NULL — `db/schema/timeTracking.ts:43` — and an absent entry is **missing information, not zero labour**), then compare medians across arms **among tickets that have at least one entry**, and publish `loggingCoverage` per arm alongside. A delta computed over 30 %-logged tickets is not a delta, and the reader must be able to see that.

- [ ] **Step 1: Write the failing test**

```ts
it('omits ONLY the technician-minutes arm for a caller without the time-entry permission', async () => {
  const dto = await loadMeasuredImpact(authAiReadOnly, { window: 30 });
  expect(dto.technicianMinutes).toEqual({ omitted: 'insufficient_authority' });
  expect(dto.alertResolution.omitted).not.toBe('insufficient_authority');
});

it('omits the WHOLE band for a site-restricted caller', async () => {
  const dto = await loadMeasuredImpact(authSiteRestricted, { window: 30 });
  expect(dto.alertResolution.omitted).toBe('site_restricted');
  expect(dto.ticketFirstResponse.omitted).toBe('site_restricted');
  expect(dto.technicianMinutes).toEqual({ omitted: 'site_restricted' });
});

it('never reads time entries through a system context', () => {
  const src = readFileSync(path.join(__dirname, 'impactMeasured.ts'), 'utf8');
  expect(src, 'a system-context read here would bypass the time-entry policy outright (#2417)')
    .not.toMatch(/withSystemDbAccessContext/);
});

it('excludes a running timer (NULL duration) from the recorded minutes', async () => {
  const dto = await loadMeasuredImpact(authFull, { window: 30 });
  expect(medianFor(dto, COHORT)).toBe(EXPECTED_WITHOUT_RUNNING_TIMER);
});

it('publishes logging coverage per arm', async () => {
  const dto = await loadMeasuredImpact(authFull, { window: 30 });
  expect(dto.technicianMinutes).toMatchObject({
    omitted: null, loggingCoverage: { aiTouched: expect.any(Number), untouched: expect.any(Number) },
  });
});

it('caps the window at 90 days', async () => {
  await expect(loadMeasuredImpact(authFull, { window: 180 as never })).rejects.toThrow();
});

it('through is the last COMPLETE UTC day', async () => {
  const dto = await loadMeasuredImpact(authFull, { window: 7 });
  expect(dto.through).toBe(lastCompleteUtcDay());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/impactMeasured.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** per the four authorization rules and the metric definition above.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiAgents/impactMeasured.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/impactMeasured.ts apps/api/src/services/aiAgents/impactMeasuredCohorts.ts apps/api/src/services/aiAgents/impactMeasured.test.ts
git commit -m "feat(ai): technician-minutes arm with its own authorization and logging-coverage disclosure"
```

---

### Task 7: `GET /ai/agents/impact/measured`

**Files:**
- Modify: `apps/api/src/routes/aiAgents.ts` (beside the existing `/impact` handler at `:1552`)
- Test: `apps/api/src/routes/aiAgents.test.ts`

**Interfaces:**
- Produces: `GET /ai/agents/impact/measured?window=7|30|90[&orgId=<uuid>]` → `{ data: AiAgentImpactMeasuredDto }`. Same `scopes` + `requireAiRead` middleware as `/impact` (the measured band's *extra* requirements are enforced inside `loadMeasuredImpact` as omissions, not as 403s — a partner admin should see two of three signals, not an error page). A system-scope caller must supply `orgId`, matching `:1562-1568`.

**Why a separate endpoint rather than widening `/impact`.** The measured queries are heavier and have different authorization outcomes per signal; folding them in would make the estimate band's latency hostage to the measured band's, and would force the estimate DTO to grow an `omitted` vocabulary it does not need.

- [ ] **Step 1: Write the failing test**

```ts
it('returns the measured DTO for a partner-scope caller', async () => {
  const res = await app.request('/ai/agents/impact/measured?window=30', {}, partnerEnv);
  expect(res.status).toBe(200);
  expect((await res.json()).data).toMatchObject({ schemaVersion: 1, window: 30 });
});

it('rejects an unsupported window', async () => {
  expect((await app.request('/ai/agents/impact/measured?window=180', {}, partnerEnv)).status).toBe(400);
});

it('rejects a client-supplied through', async () => {
  expect((await app.request('/ai/agents/impact/measured?window=30&through=2026-01-01', {}, partnerEnv)).status).toBe(400);
});

it('requires orgId for a system-scope caller, like /impact does', async () => {
  expect((await app.request('/ai/agents/impact/measured?window=30', {}, systemEnv)).status).toBe(400);
});

it('403s a caller without ai_agents:read', async () => {
  expect((await app.request('/ai/agents/impact/measured?window=30', {}, noAiReadEnv)).status).toBe(403);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Write the handler.**

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/aiAgents.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 5 new tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts
git commit -m "feat(ai): GET /ai/agents/impact/measured"
```

---

### Task 8: Split `ImpactPage.tsx` into two bands, and render the measured one

**Files:**
- Create: `apps/web/src/components/aiAgents/ImpactEstimateBand.tsx` (moves today's `ImpactPage.tsx:717-1013` — the priced/unpriced tile grids `:745-846`, the chart `:862-943`, the by-org table `:943-1013`)
- Create: `apps/web/src/components/aiAgents/ImpactMeasuredBand.tsx`
- Modify: `apps/web/src/components/aiAgents/ImpactPage.tsx` (1014 lines → a host keeping the helpers `:1-278`, `Tile` `:279-338`, the state/data layer `:339-544`, the header + window selector `:545-706` and the weights drawer `:706-716`)
- Create: `apps/web/src/components/aiAgents/ImpactMeasuredBand.test.tsx`
- Test: `apps/web/src/components/aiAgents/ImpactPage.test.tsx` (exists — must pass **unchanged** after the split)

**Interfaces:**
- Produces: `<ImpactEstimateBand data={impactDto} … />` and `<ImpactMeasuredBand window={windowDays} />` (fetches its own data, so a slow measured query never blocks the estimate band).

**Copy rules — the band is worthless if the labelling is wrong:**
- Heading: **"Measured (correlational)"**, directly beneath the estimate band, visually separated.
- Every cohort shows its `n` per arm. A cohort below 20 is not rendered at all.
- Standing caption: *"AI-touched vs untouched work of the same kind, in the same window. Not a before/after comparison, and not a causal claim — the AI generally reaches the easier items first."*
- The primary figure is labelled *"resolved within 24 h"* / *"first response within 4 h"*. Any p50/p90 shown is labelled *"conditional on completion, right-censored"*.
- Technician minutes: *"recorded minutes"*, never "time spent", with the logging-coverage percentage adjacent.
- Never the word "saved" anywhere in this band.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders each cohort with both arm sizes', async () => {
  mockMeasured({ alertResolution: { cohorts: [cohort({ aiN: 40, unN: 60 })], omitted: null, exposureAgeMinutes: 15, horizonHours: 24 } });
  render(<ImpactMeasuredBand window={90} />);
  const el = await screen.findByTestId('measured-cohort-rule-a');
  expect(el).toHaveTextContent('40');
  expect(el).toHaveTextContent('60');
});

it('shows an explicit not-enough-data state instead of an empty band', async () => {
  mockMeasured({ alertResolution: { cohorts: [], omitted: 'insufficient_data', exposureAgeMinutes: 15, horizonHours: 24 } });
  render(<ImpactMeasuredBand window={90} />);
  expect(await screen.findByTestId('measured-alert-omitted')).toHaveTextContent(/not enough/i);
});

it('renders the other two signals when only technician minutes is unauthorized', async () => {
  mockMeasured({ technicianMinutes: { omitted: 'insufficient_authority' } });
  render(<ImpactMeasuredBand window={90} />);
  expect(await screen.findByTestId('measured-alert-resolution')).toBeInTheDocument();
  expect(screen.getByTestId('measured-technician-minutes-omitted')).toBeInTheDocument();
});

it('never says "saved" and never says "before/after"', async () => {
  mockMeasured(fullFixture);
  render(<ImpactMeasuredBand window={90} />);
  const text = (await screen.findByTestId('measured-band')).textContent!.toLowerCase();
  expect(text).not.toContain('saved');
  expect(text).not.toContain('before');
  expect(text).toContain('correlational');
});

it('shows logging coverage beside the recorded-minutes figures', async () => {
  mockMeasured(fullFixture);
  render(<ImpactMeasuredBand window={90} />);
  expect(await screen.findByTestId('measured-logging-coverage')).toBeInTheDocument();
});

it('a slow measured fetch does not block the estimate band', async () => {
  mockMeasuredNeverResolves();
  render(<ImpactPage />);
  expect(await screen.findByTestId('ai-impact-chart')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/aiAgents/ImpactMeasuredBand.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Do the split first, then add the band.**

Move `:717-1013` into `ImpactEstimateBand.tsx` **verbatim** and re-render it from `ImpactPage`; run `ImpactPage.test.tsx` and confirm it passes **with no edits** — that is the proof the split is inert. Only then write `ImpactMeasuredBand.tsx` with its own `fetchWithAuth('/ai/agents/impact/measured?window=…')`, its own loading and error states, and `data-testid="measured-band"` on the root.

Keep the window selector, the weights drawer and the PDF export in `ImpactPage` (the host). If the PDF export should include the measured figures, add them through `buildImpactPdfRows` (`ImpactPage.tsx:230`) rather than duplicating the export.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/aiAgents
cd apps/web && npx astro check
```
Expected: PASS — including `ImpactPage.test.tsx` and `ImpactWeightsDrawer.test.tsx` unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/aiAgents
git commit -m "feat(web): split ImpactPage into estimate and measured bands, and render the measured band"
```

---

### Task 9: Translations in all 8 locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/ai.json`
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `translationCoverage.test.ts`

**Keys:** `impact.measured.heading`, `.caption`, `.alertResolution`, `.ticketFirstResponse`, `.technicianMinutes`, `.withinHorizon`, `.censoredNote`, `.cohortSize`, `.loggingCoverage`, `.omitted.insufficientData`, `.omitted.insufficientFollowup`, `.omitted.insufficientAuthority`, `.omitted.siteRestricted`.

- [ ] **Step 1: Run the parity tests to see them fail**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```
Expected: FAIL — keys present in `en` only.

- [ ] **Step 2: Write real translations** in the other seven locales. Copying the English string counts as an untranslated duplicate against that namespace's frozen baseline; do not raise the baseline.

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/lib/i18n
```
Expected: PASS, no baseline raised.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales
git commit -m "i18n(ai): measured-impact strings in all 8 locales"
```

---

### Task 10: p95 latency budget, live-DB suites, and the PR

**Files:**
- Create: `apps/api/src/__tests__/integration/impactMeasuredPerformance.integration.test.ts`

**Interfaces:**
- Produces: a budget assertion. OD-6 A ships the read-time service **with an explicit p95 budget and B (a rollup table) named as the escape hatch if it is exceeded** — so the budget has to exist as a test, not as an intention.

**The budget:** `loadMeasuredImpact(auth, { window: 90 })` against a seeded org with **50 000 alerts across 20 rules and 20 000 tickets** completes in **under 2 500 ms p95** over 10 runs, as `breeze_app` under an org-scoped access context. If it does not, do **not** relax the budget — record the measurement in the PR and open the OD-6 B rollup follow-up.

- [ ] **Step 1: Write the failing test**

```ts
import './setup';

it('a 90-day measured read over 50k alerts and 20k tickets stays within the p95 budget', async () => {
  await seedLargeMeasuredFixture({ alerts: 50_000, rules: 20, tickets: 20_000 });
  const timings: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    await loadMeasuredImpact(auth, { window: 90 });
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(0.95 * timings.length) - 1]!;
  expect(p95, `p95 ${p95.toFixed(0)}ms exceeds the 2500ms budget — see spec OD-6 B (rollup escape hatch)`)
    .toBeLessThan(2500);
}, 300_000);

it('the alert cohort scan uses alerts_org_rule_triggered_idx, not a seq scan', async () => {
  // EXPLAIN as breeze_app with enable_seqscan=off, via the shared helper
  // src/__tests__/integration/explainAsBreezeApp.ts — the same mechanics
  // deviceEventsFeedIndexes.integration.test.ts uses.
  const plan = await explainAsBreezeApp(alertCohortSql, orgContext);
  expect(plan).toContain('alerts_org_rule_triggered_idx');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/impactMeasuredPerformance.integration.test.ts
```
Expected: FAIL initially (the seed helper does not exist), then measure honestly.

- [ ] **Step 3: Run the full live-DB set**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/impactMeasuredExposure.integration.test.ts \
  src/__tests__/integration/impactMeasuredSignals.integration.test.ts \
  src/__tests__/integration/impactMeasuredPerformance.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```
W04 adds **no table and no column**, so the export/cascade/merge registries need no entry — the last three are run as regression proof, not because a change is expected. `rls-coverage` matters because the measured queries read four tenant tables (`alerts`, `tickets`, `time_entries` — partner-axis — and `ai_alert_verdicts`) under the caller's own context.

- [ ] **Step 4: Full sweep and PR**

```bash
cd apps/api && npx vitest run
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd apps/web && npx vitest run && npx astro check
cd packages/shared && npx vitest run && npx tsc --noEmit
pnpm lint
pnpm test-stack down
```

PR against `main`, body `Closes #<wave sub-issue>` and `Refs #4182`. The body must state: the measured p95 number; that the band is correlational and never called before/after; that `sla_compliance` was ruled out as a source because it has no writer; and — per **OD-4 A** — that #4182 is **not** blocked on #4177, because `time_entries` already exists on `main` (`db/schema/timeTracking.ts:22-72`) and #4177 adds AI *suggestions* and an actual-labor split that enrich the metric without being required to compute it. Update #4182's description to record that, since it contradicts the filed issue text.

Merge with `gh pr merge <N>` — never `--admin`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/impactMeasuredPerformance.integration.test.ts
git commit -m "test(ai): p95 latency budget for the read-time measured-impact service"
```
