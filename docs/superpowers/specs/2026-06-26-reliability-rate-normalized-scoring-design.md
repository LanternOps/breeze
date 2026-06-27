# Reliability scoring: rate-normalize fault factors by observed up-days (#1908 a+b)

**Status:** approved design
**Issue:** #1908 (fast-follow to closed umbrella #1904)
**Scope:** parts (a) rate-normalize fault factors + (b) age-normalize beyond uptime. Parts (c) weight re-tune and (d) fleet calibration of band cutoffs / k-constants are explicitly **deferred** and remain on #1908.

## Problem

After #1967, the four fault factors (crashes, hangs, service failures, hardware errors) feed **raw 30d/7d window totals** into the de-saturation curve `100·e^(−weightedCount/k)`:

```
scoreCrashes        = saturatingScore(crash30d + 0.5·crash7d,            K_CRASHES=3)
scoreHangs          = saturatingScore(hang30d + unresolvedHang30d,       K_HANGS=6)
scoreServiceFailures= saturatingScore(max(0, svc30d − 0.5·recovered30d), K_SERVICES=5)
scoreHardwareErrors = saturatingScore(crit·2 + err·1 + warn·0.34,        K_HARDWARE=3)
```

The curve de-saturates (14 vs 1466 no longer score identically), but raw counts mean:
- A device observed only part of the window is judged as if fully observed. Frequent-offline and recently-enrolled devices are scored on absolute counts they had less opportunity to *not* accumulate.
- A busy box and a failing box aren't separated by observation window — `events/observed-up-day` is the discriminating signal #1908 asks for, and it's not used.

`observedUpDayKeys()` already exists in `reliabilityScoring.ts` but is consumed **only** by the uptime factor; the fault factors ignore it.

## Design

### Normalization model

Keep each factor's existing weighted-count numerator (preserves the 7d-recency emphasis), then convert to a per-up-day **rate** before the curve:

```
rate        = weightedCount / max(observedUpDays30, MIN_DAYS)
factorScore = 100 · e^(−rate / k_rate)
```

- `observedUpDays30` = number of distinct UTC day-keys in the **last 30 days** with at least one reliability sample. New helper `countObservedUpDaysInWindow(dailyBuckets, days, now)` derived from the same `sampleCount > 0` rule as `observedUpDayKeys()`, windowed to match `sumBucketsInWindow`. (We count *reporting* days, not boot-covered days — the denominator is "days the device had the opportunity to report events.")
- `MIN_DAYS = 14` — smoothing floor so a sparse/young device can't read a single event as a large daily rate. See tradeoff table below.
- Uptime factor unchanged (already observation/age-aware via #1746/#1851).

### Constants — zero regression for mature always-on devices

Set `k_rate = k_raw / REFERENCE_DAYS` with `REFERENCE_DAYS = 30`:

| factor | k_raw (today) | k_rate (new) |
|---|---|---|
| crashes | 3 | 0.10 |
| hangs | 6 | 0.20 |
| services | 5 | 0.1667 |
| hardware | 3 | 0.10 |

Algebraic identity: for a device with a full 30 observed up-days,
`rate = weightedCount/30` and `saturatingScore(weightedCount/30, k_raw/30) = 100·e^(−weightedCount/k_raw)` —
**exactly today's #1967 score.** The change only bites for devices with fewer than 30 observed up-days (young or frequently offline) — precisely the population #1908 targets. Because `max(observedUpDays30, MIN_DAYS)` caps the denominator at `observedUpDays30 ≤ 30`, mature always-on devices are a no-op.

### Young-device tradeoff (why MIN_DAYS=14)

Rate-normalization inherently scores a young device with 1 event lower than a mature device with 1 event (higher per-day rate). `MIN_DAYS` damps this. For **1 weighted crash** (k_rate=0.10):

| observed up-days | MIN_DAYS=7 | MIN_DAYS=14 (chosen) |
|---|---|---|
| 30 (mature) | 72 (= today) | 72 |
| 14 | 49 | 49 |
| 7 | 24 | 49 |
| 3 (floored) | 24 | 49 |

MIN_DAYS=7 drops a single-crash 7-day device to 24 ("critical"), re-creating the "young device looks alarming" problem #1904 was filed over. MIN_DAYS=14 lands a lone crash at 49 ("poor"), two crashes at 24 — discrimination without false alarm. Final value is subject to #1908(d) fleet calibration; 14 is the reasoned starting point.

### Daily/trend score is intentionally NOT rate-normalized

`scoreDailyBucket()` scores a **single day's** bucket for the trend slope (`computeTrend`). A per-day bucket is already a one-day quantity; dividing by up-days is meaningless (always 1, or harmfully floored). It stays on raw per-day counts with the existing `K_*` constants. Only the **headline window scorers** are rate-normalized. (This corrects the initial "keep in lockstep" framing — the daily score and the window score measure different things.)

## Code surface

All in `apps/api/src/services/reliabilityScoring.ts`:

1. Add `K_CRASHES_RATE / K_HANGS_RATE / K_SERVICES_RATE / K_HARDWARE_RATE` and `RELIABILITY_RATE_REFERENCE_DAYS = 30`, `RELIABILITY_RATE_MIN_DAYS = 14` constants near the existing `K_*`.
2. Add helper `countObservedUpDaysInWindow(dailyBuckets, days, now)`.
3. Change signatures of `scoreCrashes / scoreHangs / scoreServiceFailures / scoreHardwareErrors` to take an `observedUpDays30: number` argument; inside, compute `rate = weightedCount / max(observedUpDays30, RELIABILITY_RATE_MIN_DAYS)` and call `saturatingScore(rate, k_rate)`.
4. In `computeAndPersistDeviceReliability`, compute `observedUpDays30 = countObservedUpDaysInWindow(dailyBuckets, 30, now)` and thread it into the four scorer calls (~lines 1158-1165).
5. `scoreDailyBucket` unchanged.
6. Update the `reliabilityScoringInternals` test export to expose the new helper/constants as needed.

No schema, migration, route, web, or agent change. Pure scoring-service change; takes effect on the next nightly recompute after deploy.

## Tests (TDD, `reliabilityScoring.test.ts`)

1. **Regression guard:** a device with exactly 30 observed up-days scores identically to the pre-change (#1967) values for representative counts (1/3/10 crashes etc.).
2. **Rate discrimination:** same raw count, fewer observed up-days → strictly lower factor score.
3. **MIN_DAYS floor:** sparse device (e.g. 2 up-days) uses denominator 14, not 2 — single event does not crater the score; assert exact reference values from the table.
4. **Monotonicity preserved:** more events → strictly lower score at fixed up-days; fewer up-days → strictly lower score at fixed count.
5. **Young-device reference table:** the MIN_DAYS=14 column above as explicit expected values.
6. **scoreDailyBucket untouched:** existing daily/trend tests still pass unchanged.
7. Update existing curve tests for the new `scoreCrashes/...` signatures (pass `observedUpDays30 = 30` to preserve their current expectations).

## Deferred (stay on #1908)

- (c) Weight-profile re-tuning (workstation/infra).
- (d) Fleet calibration of `MIN_DAYS`, `k_rate` values, and `scoreBand` cutoffs against real US/EU `device_reliability_history` data.
