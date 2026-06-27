# Reliability Rate-Normalized Fault Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate-normalize the four reliability fault factors (crashes, hangs, service failures, hardware errors) by observed up-days so young/offline devices are scored fairly, without regressing mature always-on devices.

**Architecture:** Each fault scorer keeps its existing weighted-count numerator, then divides by `max(observedUpDays30, MIN_DAYS)` to produce a per-up-day rate before the existing `saturatingScore` exponential curve. Setting `k_rate = k_raw / 30` makes a device with a full 30 observed up-days score identically to today (provable no-op). The new `observedUpDays30` argument is **optional, defaulting to 30**, so the no-op case is the default and every existing test stays green unchanged.

**Tech Stack:** TypeScript, Vitest. Single file: `apps/api/src/services/reliabilityScoring.ts` + its test `reliabilityScoring.test.ts`.

## Global Constraints

- `RELIABILITY_RATE_REFERENCE_DAYS = 30` (verbatim).
- `RELIABILITY_RATE_MIN_DAYS = 14` (verbatim — smoothing floor).
- `k_rate` for each factor is computed as `K_X / RELIABILITY_RATE_REFERENCE_DAYS`, never hardcoded, to keep the 30-up-day no-op identity exact.
- No schema, migration, route, web, or agent changes. Pure scoring-service change.
- `scoreDailyBucket` (trend) is NOT rate-normalized — a per-day bucket is already a one-day quantity.
- Scope is #1908 parts (a)+(b) only. Parts (c) weight re-tune and (d) fleet calibration stay deferred on #1908.
- Run tests from `apps/api`: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts`.
- Type-check from `apps/api`: `pnpm exec tsc --noEmit`.

---

### Task 1: Observed-up-days helper + rate constants

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts` (add constants near `K_HARDWARE` at line 293; add helper near `sumBucketsInWindow` at line 778; add both to the `reliabilityScoringInternals` export at line 1866)
- Test: `apps/api/src/services/reliabilityScoring.test.ts`

**Interfaces:**
- Consumes: existing `bucketsInWindow(dailyBuckets, days, now)` (line 764), `DailyAggregateBucket` type (has `sampleCount: number`, `date: string`).
- Produces:
  - `const RELIABILITY_RATE_REFERENCE_DAYS = 30`
  - `const RELIABILITY_RATE_MIN_DAYS = 14`
  - `function countObservedUpDaysInWindow(dailyBuckets: DailyAggregateBucket[], days: number, now: Date): number` — count of in-window buckets with `sampleCount > 0`.
  - Both constants + the helper exported on `reliabilityScoringInternals`.

- [ ] **Step 1: Write the failing test**

Add this block to `apps/api/src/services/reliabilityScoring.test.ts` (near the other `reliabilityScoringInternals` describe blocks). It uses the same minimal-bucket shape the existing tests use; if those tests use a `makeBucket`/`buildBucket` helper, reuse it instead of the inline literal and pass only `date`/`sampleCount`.

```ts
// Issue #1908: rate-normalization denominator = observed up-days in window.
describe('countObservedUpDaysInWindow', () => {
  const { countObservedUpDaysInWindow, sortDailyBuckets } = reliabilityScoringInternals;
  const now = new Date('2026-06-26T12:00:00.000Z');
  const day = (offsetDays: number) =>
    new Date(now.getTime() - offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Minimal buckets: only date + sampleCount matter for this helper.
  const buckets = sortDailyBuckets(
    new Map(
      [
        { date: day(1), sampleCount: 3 },   // in 30d window, reported
        { date: day(5), sampleCount: 1 },   // in 30d window, reported
        { date: day(10), sampleCount: 0 },  // in window but NO sample → excluded
        { date: day(40), sampleCount: 9 },  // outside 30d window → excluded
      ].map((b) => [b.date, b as any]),
    ),
  );

  it('counts only in-window buckets that have at least one sample', () => {
    expect(countObservedUpDaysInWindow(buckets, 30, now)).toBe(2);
  });

  it('shrinks the window correctly', () => {
    expect(countObservedUpDaysInWindow(buckets, 3, now)).toBe(1); // only day(1)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts -t countObservedUpDaysInWindow`
Expected: FAIL — `countObservedUpDaysInWindow is not a function` (not yet exported).

- [ ] **Step 3: Add the constants**

Insert after the `K_HARDWARE = 3;` line (currently line 293) in `apps/api/src/services/reliabilityScoring.ts`:

```ts
// Issue #1908 (a/b): rate-normalize fault factors by observed up-days. Dividing
// the weighted count by observed up-days turns "events" into "events per up-day"
// so a device observed for only part of the window — young or frequently offline
// — is not judged on absolute counts it had less opportunity to accumulate.
//
// k_rate = K_x / REFERENCE_DAYS makes a device with a full 30 observed up-days
// score IDENTICALLY to the pre-#1908(a) raw-count curve:
//   saturatingScore(weightedCount/30, K/30) == saturatingScore(weightedCount, K)
// so mature always-on devices are a provable no-op; only sub-30-up-day devices
// change. MIN_DAYS floors the denominator so one event on a 2-day-old device
// can't read as a catastrophic daily rate (see #1904's "young device looks
// alarming" complaint). 14 is the reasoned start; final value is #1908(d).
const RELIABILITY_RATE_REFERENCE_DAYS = 30;
const RELIABILITY_RATE_MIN_DAYS = 14;
```

- [ ] **Step 4: Add the helper**

Insert after the `sumBucketsInWindow` function (currently ends at line 778):

```ts
// Issue #1908: count of distinct in-window days the device actually reported
// (sampleCount > 0). This is the rate-normalization denominator — days the
// device had the opportunity to emit fault events. Mirrors observedUpDayKeys'
// "a sample means the device was up" rule, but windowed and as a count.
function countObservedUpDaysInWindow(
  dailyBuckets: DailyAggregateBucket[],
  days: number,
  now: Date
): number {
  return bucketsInWindow(dailyBuckets, days, now).filter((bucket) => bucket.sampleCount > 0).length;
}
```

- [ ] **Step 5: Export from internals**

In the `reliabilityScoringInternals` object (line 1866), add after `K_HARDWARE,`:

```ts
  countObservedUpDaysInWindow,
  RELIABILITY_RATE_REFERENCE_DAYS,
  RELIABILITY_RATE_MIN_DAYS,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts -t countObservedUpDaysInWindow`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/orca/workspaces/breeze/issue-1904-failure-counts-inflated
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.test.ts
git commit -m "feat(reliability): observed-up-days helper + rate constants (#1908)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rate-normalize the four fault scorers

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts:415-447` (the four scorer functions)
- Test: `apps/api/src/services/reliabilityScoring.test.ts`

**Interfaces:**
- Consumes: `RELIABILITY_RATE_REFERENCE_DAYS`, `RELIABILITY_RATE_MIN_DAYS`, `saturatingScore`, `K_CRASHES`, `K_HANGS`, `K_SERVICES`, `K_HARDWARE` (all in-file).
- Produces (new optional trailing param on each, defaulting to the reference so existing callers/tests are unchanged):
  - `scoreCrashes(crashCount7d, crashCount30d, observedUpDays30 = RELIABILITY_RATE_REFERENCE_DAYS)`
  - `scoreHangs(hangCount30d, unresolvedHangCount30d, observedUpDays30 = RELIABILITY_RATE_REFERENCE_DAYS)`
  - `scoreServiceFailures(serviceFailureCount30d, recoveredCount30d, observedUpDays30 = RELIABILITY_RATE_REFERENCE_DAYS)`
  - `scoreHardwareErrors(criticalCount30d, errorCount30d, warningCount30d, observedUpDays30 = RELIABILITY_RATE_REFERENCE_DAYS)`

- [ ] **Step 1: Write the failing tests**

Add this block to `reliabilityScoring.test.ts` after the existing `scoreHardwareErrors` describe block:

```ts
// Issue #1908 (a/b): rate-normalization by observed up-days.
describe('fault scorers — rate-normalization (#1908)', () => {
  const { scoreCrashes, scoreHangs, scoreServiceFailures, scoreHardwareErrors } =
    reliabilityScoringInternals;

  it('mature 30-up-day device is a no-op (matches the raw-count curve)', () => {
    // Default arg is 30, so the existing scoreCrashes(0,1)===72 already proves
    // this; here we assert it explicitly with the arg passed.
    expect(scoreCrashes(0, 1, 30)).toBe(72);
    expect(scoreHangs(1, 0, 30)).toBe(85);
    expect(scoreServiceFailures(5, 0, 30)).toBe(37);
    expect(scoreHardwareErrors(1, 0, 0, 30)).toBe(51);
  });

  it('same count + fewer observed up-days → strictly lower score', () => {
    expect(scoreCrashes(0, 2, 15)).toBeLessThan(scoreCrashes(0, 2, 30));
    expect(scoreHangs(2, 0, 15)).toBeLessThan(scoreHangs(2, 0, 30));
    expect(scoreServiceFailures(3, 0, 15)).toBeLessThan(scoreServiceFailures(3, 0, 30));
    expect(scoreHardwareErrors(0, 2, 0, 15)).toBeLessThan(scoreHardwareErrors(0, 2, 0, 30));
  });

  it('MIN_DAYS floor: sparse device uses denominator 14, not its real up-days', () => {
    // 3 up-days and 7 up-days both floor to 14 → identical score.
    expect(scoreCrashes(0, 1, 3)).toBe(scoreCrashes(0, 1, 7));
    expect(scoreCrashes(0, 1, 7)).toBe(scoreCrashes(0, 1, 14));
  });

  it('young-device reference table for one 30d crash (k_rate=0.1, MIN_DAYS=14)', () => {
    expect(scoreCrashes(0, 1, 30)).toBe(72); // mature
    expect(scoreCrashes(0, 1, 14)).toBe(49);
    expect(scoreCrashes(0, 1, 7)).toBe(49);  // floored to 14
    expect(scoreCrashes(0, 1, 3)).toBe(49);  // floored to 14
  });

  it('monotonic in up-days: more observation → higher score at fixed count', () => {
    const a = scoreCrashes(0, 3, 14);
    const b = scoreCrashes(0, 3, 22);
    const c = scoreCrashes(0, 3, 30);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts -t "rate-normalization"`
Expected: FAIL — the no-op test passes by luck on `scoreCrashes(...,30)` (third arg ignored today), but `scoreCrashes(0, 2, 15)` will EQUAL (not be less than) `scoreCrashes(0, 2, 30)` because the param is currently ignored. The `toBeLessThan` assertions fail.

- [ ] **Step 3: Implement rate-normalization in the four scorers**

Replace lines 415-447 of `apps/api/src/services/reliabilityScoring.ts` with:

```ts
function scoreCrashes(
  crashCount7d: number,
  crashCount30d: number,
  observedUpDays30: number = RELIABILITY_RATE_REFERENCE_DAYS
): number {
  // Issue #1908: weightedCount = 30d crashes + 0.5 × 7d crashes (recent events
  // weighted more heavily). Rate-normalized by observed up-days (floored at
  // MIN_DAYS); k_rate = K_CRASHES / REFERENCE_DAYS so a full-30-up-day device
  // scores exactly as the raw-count curve did.
  const weightedCount = crashCount30d + crashCount7d * 0.5;
  const rate = weightedCount / Math.max(observedUpDays30, RELIABILITY_RATE_MIN_DAYS);
  return saturatingScore(rate, K_CRASHES / RELIABILITY_RATE_REFERENCE_DAYS);
}

function scoreHangs(
  hangCount30d: number,
  unresolvedHangCount30d: number,
  observedUpDays30: number = RELIABILITY_RATE_REFERENCE_DAYS
): number {
  // Issue #1908: unresolvedHangCount is a subset of hangCount, so unresolved
  // hangs count double (appear in both terms) — preserving "unresolved costs 2×".
  // Rate-normalized by observed up-days; k_rate = K_HANGS / REFERENCE_DAYS.
  const weightedCount = hangCount30d + unresolvedHangCount30d;
  const rate = weightedCount / Math.max(observedUpDays30, RELIABILITY_RATE_MIN_DAYS);
  return saturatingScore(rate, K_HANGS / RELIABILITY_RATE_REFERENCE_DAYS);
}

function scoreServiceFailures(
  serviceFailureCount30d: number,
  recoveredCount30d: number,
  observedUpDays30: number = RELIABILITY_RATE_REFERENCE_DAYS
): number {
  // Issue #1908: recovered failures get half-weight credit. Math.max(0, ...)
  // floors the case where recoveries exceed failures. Rate-normalized by observed
  // up-days; k_rate = K_SERVICES / REFERENCE_DAYS.
  const weightedCount = Math.max(0, serviceFailureCount30d - recoveredCount30d * 0.5);
  const rate = weightedCount / Math.max(observedUpDays30, RELIABILITY_RATE_MIN_DAYS);
  return saturatingScore(rate, K_SERVICES / RELIABILITY_RATE_REFERENCE_DAYS);
}

function scoreHardwareErrors(
  criticalCount30d: number,
  errorCount30d: number,
  warningCount30d: number,
  observedUpDays30: number = RELIABILITY_RATE_REFERENCE_DAYS
): number {
  // Issue #1908: severity weighting mirrors the old 30/15/5 ratio (≈ 2/1/0.34).
  // Rate-normalized by observed up-days; k_rate = K_HARDWARE / REFERENCE_DAYS.
  const weightedCount = criticalCount30d * 2 + errorCount30d * 1 + warningCount30d * 0.34;
  const rate = weightedCount / Math.max(observedUpDays30, RELIABILITY_RATE_MIN_DAYS);
  return saturatingScore(rate, K_HARDWARE / RELIABILITY_RATE_REFERENCE_DAYS);
}
```

- [ ] **Step 4: Run the new + existing scorer tests to verify all pass**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts`
Expected: PASS — the new rate-normalization block passes, AND every pre-existing `scoreCrashes/scoreHangs/scoreServiceFailures/scoreHardwareErrors` test (which calls with no third/fourth arg → defaults to 30 → no-op) still passes unchanged. This unchanged-existing-tests result is the regression guard.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/orca/workspaces/breeze/issue-1904-failure-counts-inflated
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.test.ts
git commit -m "feat(reliability): rate-normalize fault scorers by observed up-days (#1908)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire observed up-days into the headline computation

**Files:**
- Modify: `apps/api/src/services/reliabilityScoring.ts:1133` (add the count) and `:1158-1165` (thread into the four scorer calls)
- Test: `apps/api/src/services/reliabilityScoring.test.ts`

**Interfaces:**
- Consumes: `countObservedUpDaysInWindow` (Task 1), the rate-normalized scorers (Task 2), existing `dailyBuckets` + `now` in `computeAndPersistDeviceReliability`.
- Produces: production reliability score now uses real observed up-days for the fault factors. No new exported symbol.

- [ ] **Step 1: Write the failing test**

This is an integration-style assertion that the compute path honors up-days. If the existing test file already has a `computeAndPersistDeviceReliability` harness (DB-backed), prefer extending it. Otherwise, assert at the unit boundary that the wiring uses the helper output by checking the documented call shape. Add:

```ts
// Issue #1908: the headline compute path must feed observed-up-days (not a
// constant) into the fault scorers. Guard the wiring: a 30-day history that
// reported on only 14 distinct days scores the same crash factor as
// scoreCrashes(..., 14), strictly below the fully-observed 30-day value.
describe('compute wiring feeds observed up-days into fault scorers (#1908)', () => {
  const { scoreCrashes, countObservedUpDaysInWindow, sortDailyBuckets } =
    reliabilityScoringInternals;
  const now = new Date('2026-06-26T12:00:00.000Z');
  const day = (o: number) =>
    new Date(now.getTime() - o * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it('helper output, fed to scoreCrashes, differs from the mature default', () => {
    // 14 reporting days inside the 30d window.
    const buckets = sortDailyBuckets(
      new Map(
        Array.from({ length: 14 }, (_, i) => {
          const b = { date: day(i + 1), sampleCount: 1, crashCount: 0 } as any;
          return [b.date, b];
        }),
      ),
    );
    const upDays = countObservedUpDaysInWindow(buckets, 30, now);
    expect(upDays).toBe(14);
    expect(scoreCrashes(0, 1, upDays)).toBe(49);
    expect(scoreCrashes(0, 1, upDays)).toBeLessThan(scoreCrashes(0, 1)); // 49 < 72
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes-for-the-wrong-reason**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts -t "compute wiring"`
Expected: PASS at the helper/scorer level (Tasks 1-2 already provide these). This test documents the required wiring; the actual production wiring is verified by Step 4's full suite + manual read. If the project has a DB-backed `computeAndPersistDeviceReliability` test, add a case there asserting the persisted score drops when reporting days are sparse, and run it instead — it will FAIL until Step 3.

- [ ] **Step 3: Thread the count into the compute path**

In `computeAndPersistDeviceReliability`, after line 1133 (`const observedDays = observedUpDayKeys(dailyBuckets);`) add:

```ts
  const observedUpDays30 = countObservedUpDaysInWindow(dailyBuckets, 30, now);
```

Then update the four scorer calls (currently lines 1158-1165) to:

```ts
  const uptimeScore = scoreUptime(uptime90d);
  const crashScore = scoreCrashes(crashCount7d, crashCount30d, observedUpDays30);
  const hangScore = scoreHangs(hangCount30d, unresolvedHangCount30d, observedUpDays30);
  const serviceFailureScore = scoreServiceFailures(
    serviceFailureCount30d,
    recoveredServiceCount30d,
    observedUpDays30
  );
  const hardwareErrorScore = scoreHardwareErrors(
    criticalHardwareCount30d,
    errorHardwareCount30d,
    warningHardwareCount30d,
    observedUpDays30
  );
```

- [ ] **Step 4: Run the full reliability suite + type-check**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, and `tsc` clean. Existing `computeAndPersistDeviceReliability` tests still green (mature/fully-observed fixtures have ≥30 reporting days or default to the no-op denominator).

- [ ] **Step 5: Run the broader affected suite to confirm no collateral breakage**

Run: `cd apps/api && pnpm exec vitest run src/services/reliabilityScoring.test.ts src/services/reliabilityScoring.featureFlag.test.ts src/jobs/reliabilityWorker.test.ts src/routes/reliability.test.ts`
Expected: PASS across all four files.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/orca/workspaces/breeze/issue-1904-failure-counts-inflated
git add apps/api/src/services/reliabilityScoring.ts apps/api/src/services/reliabilityScoring.test.ts
git commit -m "feat(reliability): use observed up-days in headline fault scoring (#1908)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Post-implementation

- Open a PR titled `feat(reliability): rate-normalize fault scoring by observed up-days (#1908 a+b)`. Body must `Refs #1908` (NOT `Closes` — parts c/d remain) and note it rides the next release; effect appears on the next nightly recompute after deploy, and mature 30-up-day devices are unchanged by construction.
- Leave a comment on #1908 noting (a)+(b) are now in the merged PR and (c) weight re-tune + (d) fleet calibration of MIN_DAYS/k_rate/band cutoffs remain.

## Self-Review (completed by plan author)

- **Spec coverage:** model → Task 2; denominator helper → Task 1; constants/no-op identity → Tasks 1-2; MIN_DAYS young-device behavior → Task 2 tests; wiring → Task 3; scoreDailyBucket-untouched → enforced by not modifying it (Global Constraints) and Step 5 broad suite. Deferred c/d → Post-implementation comment.
- **Placeholder scan:** none — all code shown in full.
- **Type consistency:** the optional `observedUpDays30: number = RELIABILITY_RATE_REFERENCE_DAYS` signature is identical across all four scorers and matches the call sites in Task 3 and the test args in Task 2.
