/**
 * Central slot registry for coarse (>= hourly) BullMQ repeatable schedules.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * BullMQ computes the next run of a `repeat: { every: N }` job as
 * `Math.floor(now / N) * N + N`. That is anchored to the Unix epoch, not to
 * process start, so every job registered with the same `every` value fires on
 * the same wall-clock boundary — forever. Because 86_400_000 ms divides the
 * epoch evenly, EVERY `every: 24h` job fires at exactly 00:00:00.000 UTC.
 *
 * On 2026-08-23 a read-only `ZRANGE` over the US production Redis showed 18 of
 * 97 repeat entries scheduled for the identical millisecond
 * (2026-08-24T00:00:00.000Z = 1787529600000). Eleven of them are batched
 * `DELETE ... LIMIT 10000` retention loops sharing the API's 30-connection
 * Postgres pool with live agent traffic. The nightly Sentry cluster
 * (CONNECTION_CLOSED / ECONNRESET around 00:01–00:02 UTC) is that pile-up
 * plus the 60-second tick jobs landing on an already-saturated pool.
 *
 * This module is the allocator: one entry per coarse repeatable schedule in
 * the API, including the ones whose defining file still spells the pattern
 * inline. `scheduleRegistry.contract.test.ts` proves, against real source and
 * a real cron parser, that no coarse `every:` survives, that every coarse
 * pattern is allocated here exactly once, and that no two coarse schedules
 * ever fire in the same minute.
 *
 * MINUTE LANES
 * ------------
 * Minutes are allocated in lanes mod 5, because the *uncontrolled* schedules —
 * the 43 sub-hourly `every:` ticks this registry deliberately does not manage
 * (5s/30s/60s/2m/5m/10m/15m/30m sweeps) plus the every-5-minute and
 * every-10-minute cron ticks —
 * all land on minutes ≡ 0 (mod 5).
 *
 *   ≡ 3 (mod 5)  daily tier — the heavy batched-DELETE retention jobs
 *   ≡ 2 (mod 5)  sub-daily tier — cheap hourly / 6-hourly sweeps
 *   ≡ 0 (mod 5)  left to the unmanaged fine-grained ticks
 *
 * Three legacy sub-daily slots (:00, :15, :35) predate the lanes and are not
 * worth churning; they are collision-checked like everything else.
 *
 * HONEST SCOPE — what this does NOT fix
 * -------------------------------------
 * The 43 sub-hourly `every:` registrations are exempt by design: a 60-second
 * tick has to fire every 60 seconds, and re-anchoring it buys nothing. They
 * are still epoch-aligned, so the 5/10/15/30-minute jobs *do* all converge on
 * 00:00:00.000 alongside each other. The production ZRANGE that motivated this
 * work was taken mid-day and structurally could not show them. Midnight is
 * therefore quieter, not empty — what changed is that the heavy daily batch
 * deletes are no longer part of the convergence.
 *
 * ALLOCATING A NEW SLOT
 * ---------------------
 * Add a key below with a cron pattern, then use `jobSchedule('<key>')` in the
 * `repeat: { pattern }` of the registration. Pick a free minute in the lane for
 * your tier — the contract test tells you if you collided. Do NOT reach for
 * `every:` for anything an hour or coarser.
 *
 * All patterns are interpreted in the container's local timezone, which is UTC
 * on every Breeze deployment. (`repeat.tz` is not pinned; a self-hoster who
 * sets a non-UTC `TZ` shifts the whole grid coherently, so the collision
 * guarantees hold, but absolute times move.)
 */

import { isStructurallyValidCron } from '@breeze/shared';
import { captureException } from '../services/sentry';

/** A repeatable interval at or above this is epoch-aligned enough to matter. */
export const COARSE_REPEAT_INTERVAL_MS = 60 * 60 * 1000;

/** Schedules with a minimum gap at or above this are the "daily tier". */
export const DAILY_REPEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * key -> cron pattern. Grouped by tier, ordered by fire time inside each tier
 * so an unused slot is easy to spot.
 */
export const JOB_SCHEDULES = {
  // ---------------------------------------------------------------- daily tier
  // Minutes ≡ 3 (mod 5), one job per (hour, minute).
  'device-metrics-retention': '3 0 * * *',
  'process-sample-retention': '23 0 * * *',
  'service-process-check-retention': '43 0 * * *',
  'vulnerability-accept-expiry': '3 1 * * *',
  'reliability-scoring': '8 2 * * *',
  'backup-readiness-score': '18 2 * * *',
  'oauth-cleanup': '8 3 * * *',
  'metric-rollup-maintenance': '13 3 * * *',
  'audit-policy-collection': '18 3 * * *',
  'audit-retention': '28 3 * * *',
  'backup-weekly-test-restore': '38 3 * * 0',
  'stripe-account-cache-refresh': '48 3 * * *',
  'enrollment-key-cleanup': '8 4 * * *',
  'audit-chain-verify': '13 4 * * *',
  'pax8-sync': '28 4 * * *',
  'audit-chain-anchor': '48 4 * * *',
  'contract-billing-sweep': '8 5 * * *',
  'tdsynnex-sftp-sync': '38 5 * * *',
  'auth-browser-transition-cleanup': '58 5 * * *',
  'invoice-overdue-sweep': '8 6 * * *',
  'event-log-retention': '3 7 * * *',
  'agent-log-retention': '23 7 * * *',
  'change-log-retention': '43 7 * * *',
  'ip-history-retention': '3 8 * * *',
  'ml-output-retention': '23 8 * * *',
  'user-risk-retention': '43 8 * * *',
  'vulnerability-msrc-sync': '3 9 * * *',
  'abuse-signals-digest': '18 9 * * 1',
  'vulnerability-nvd-sync': '3 10 * * *',
  'vulnerability-kev-epss-sync': '3 11 * * *',
  'vulnerability-sofa-sync': '3 12 * * *',
  'vulnerability-correlate': '3 13 * * *',
  'reliability-history-retention': '3 14 * * *',
  'playbook-execution-retention': '23 14 * * *',
  'cve-enrichment': '43 14 * * *',
  'receipt-retention': '3 15 * * *',
  'winget-index-sync': '3 16 * * *',
  'sso-domain-recheck': '23 16 * * *',
  'exchange-rate-sync': '13 17 * * *',
  'ai-unattended-exposure-retention': '8 18 * * *',
  // P2-5 (#4192, Task A2-3): daily graduation eligibility sweep. Runs after
  // the evidence-window's day has fully closed, same lane as its sibling
  // retention slot below (same queue/worker — Deviation #10).
  'ai-agent-graduation-evaluate': '28 18 * * *',
  // P2-6 (#4193): nightly value-accounting rollup. Daily lane; hour 18 held
  // only minute 8 before this. Runs well after the day it summarises closed.
  'ai-agent-impact-rollup': '33 18 * * *',
  'ai-agent-op-evidence-retention': '48 18 * * *',

  // ------------------------------------------------------------ sub-daily tier
  // Minutes ≡ 2 (mod 5), plus three legacy slots on :00 / :15 / :35. Minute 0
  // belongs to the hourly risk-score refresh alone — nothing daily may sit on
  // it, or the two co-fire once a day (that was the #3793 128-second pool hold).
  'vulnerability-risk-score-refresh': '0 * * * *',
  'security-posture-scan': '7 * * * *',
  'snmp-retention': '12 1,7,13,19 * * *',
  'software-upload-session-cleanup': '15 * * * *',
  'audit-drift-evaluator': '17 * * * *',
  'abuse-signals-sweep': '22 * * * *',
  'backup-expired-snapshot-cleanup': '27 2,8,14,20 * * *',
  'software-remediation-request-cleanup': '35 * * * *',
  'backup-recovery-token-expiry': '37 * * * *',
  'warranty-batch-sync': '42 3,9,15,21 * * *',
  'cis-scan-scheduler': '47 * * * *',
  'cis-score-aggregator': '52 * * * *',
  // W08 #3902 — hourly sweep of abandoned pending ticket-comment attachments.
  // :32 is one of the two remaining free minutes in the ≡2 (mod 5) lane.
  'ticket-attachment-pending-reaper': '32 * * * *',
  'user-risk-scan': '57 4,10,16,22 * * *',
} as const;

export type JobScheduleKey = keyof typeof JOB_SCHEDULES;

/**
 * Resolve an allocated slot. Prefer this over an inline pattern string so the
 * slot map stays the single place a schedule is chosen.
 */
export function jobSchedule(key: JobScheduleKey): string {
  return JOB_SCHEDULES[key];
}

// ---------------------------------------------------------------------------
// Operator overrides
// ---------------------------------------------------------------------------

/**
 * Structural validation of an operator-supplied cron pattern.
 *
 * Deliberately does NOT use `cron-parser` — that is a devDependency, and this
 * module is loaded by the production API. This checks field count and per-field
 * token/range validity, which is what catches the realistic operator mistake
 * (a two-field value such as star-slash-five, which looks fine and is not).
 * `scheduleRegistry.contract.test.ts`
 * cross-checks this function against the real parser over a corpus.
 *
 * Moved to `@breeze/shared` (P2-2 task 2) so the scheduled-sweeps schedule
 * validator (`validators/aiAgentSchedules.ts`) can reuse the same structural
 * rule instead of duplicating it — re-exported here (rather than left as an
 * import-only consumer) so every existing caller of this module keeps working
 * unchanged.
 */
export { isStructurallyValidCron };

/**
 * Read an operator cron override, falling back LOUDLY to the allocated slot.
 *
 * Why the fallback rather than a throw: BullMQ's `getNextMillis` calls
 * `parseExpression` outside its try/catch, so an invalid pattern rejects
 * `queue.add`, which propagates to the initializer catch in `index.ts` — and
 * that pins `/ready` to not-ready for the process lifetime. A self-hoster
 * typo'ing a two-field `USER_RISK_SCAN_CRON` would boot an API that serves 503s to
 * every agent and browser. A stale cadence plus a loud error is strictly better
 * than a dead API.
 *
 * `legacyEnvName` names the pre-stagger `*_INTERVAL_MS` knob this replaced, so
 * a self-hoster still setting it is told it is now inert instead of silently
 * getting a different cadence.
 */
export function cronFromEnv(
  envName: string,
  key: JobScheduleKey,
  legacyEnvName?: string,
): string {
  const fallback = jobSchedule(key);

  if (legacyEnvName && process.env[legacyEnvName]) {
    console.warn(
      `[ScheduleRegistry] ${legacyEnvName} is no longer read and has no effect. `
      + `Repeatable job cadences are cron patterns now — set ${envName} instead `
      + `(current schedule: '${fallback}'). See UPGRADING.md.`,
    );
  }

  const override = process.env[envName];
  if (!override) return fallback;

  if (!isStructurallyValidCron(override)) {
    const error = new Error(
      `[ScheduleRegistry] ${envName}='${override}' is not a valid cron pattern; `
      + `falling back to '${fallback}'. A cron pattern has 5 fields `
      + `(minute hour day-of-month month day-of-week), e.g. '*/5 * * * *'.`,
    );
    console.error(error.message);
    captureException(error);
    return fallback;
  }

  return override;
}
