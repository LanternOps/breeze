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
 * The fix is to give every coarse schedule an explicit cron slot. This module
 * is the allocator: one entry per coarse repeatable schedule in the API,
 * including the ones whose defining file still spells the pattern inline.
 * `scheduleRegistry.contract.test.ts` proves, against real source and a real
 * cron parser, that:
 *
 *   1. no repeatable job uses `repeat: { every: N }` with N >= 1 hour;
 *   2. every coarse `repeat: { pattern }` in the API resolves to a value in
 *      this map (a brand-new hardcoded pattern fails — allocate a slot here);
 *   3. every key here is actually registered, exactly once (no dead slots);
 *   4. no two daily-or-coarser schedules ever fire in the same minute;
 *   5. no two sub-daily coarse schedules share a minute-of-hour.
 *
 * ALLOCATING A NEW SLOT
 * ---------------------
 * Add a key below with a cron pattern, then use `jobSchedule('<key>')` in the
 * `repeat: { pattern }` of the registration. Pick a free (hour, minute) for a
 * daily job or a free minute-of-hour for an hourly/6-hourly job — the contract
 * test tells you if you collided. Do NOT reach for `every:` for anything an
 * hour or coarser.
 *
 * All patterns are interpreted in the container's local timezone, which is UTC
 * on every Breeze deployment.
 *
 * KNOWN, DELIBERATE LIMITATION: overlap *between* the daily tier and the
 * sub-daily tier is not asserted. `vulnerabilityJobs.ts` owns minute 0 for both
 * its hourly risk-score refresh and its six daily feed syncs, and those cannot
 * be separated without splitting that file's schedule. Every slot allocated
 * here since keeps daily jobs off the minutes used by sub-daily jobs by
 * convention.
 */

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
  'device-metrics-retention': '5 0 * * *',
  'process-sample-retention': '25 0 * * *',
  'service-process-check-retention': '45 0 * * *',
  'vulnerability-accept-expiry': '0 1 * * *',
  'reliability-scoring': '0 2 * * *',
  'backup-readiness-score': '20 2 * * *',
  'oauth-cleanup': '0 3 * * *',
  'audit-policy-collection': '10 3 * * *',
  'metric-rollup-maintenance': '15 3 * * *',
  'audit-retention': '30 3 * * *',
  'backup-weekly-test-restore': '40 3 * * 0',
  'stripe-account-cache-refresh': '45 3 * * *',
  'enrollment-key-cleanup': '0 4 * * *',
  'audit-chain-verify': '15 4 * * *',
  'pax8-sync': '25 4 * * *',
  'audit-chain-anchor': '45 4 * * *',
  'contract-billing-sweep': '0 5 * * *',
  'tdsynnex-sftp-sync': '40 5 * * *',
  'invoice-overdue-sweep': '0 6 * * *',
  'event-log-retention': '5 7 * * *',
  'agent-log-retention': '25 7 * * *',
  'change-log-retention': '45 7 * * *',
  'ip-history-retention': '5 8 * * *',
  'ml-output-retention': '25 8 * * *',
  'user-risk-retention': '45 8 * * *',
  'vulnerability-msrc-sync': '0 9 * * *',
  'abuse-signals-digest': '20 9 * * 1',
  'vulnerability-nvd-sync': '0 10 * * *',
  'vulnerability-kev-epss-sync': '0 11 * * *',
  'vulnerability-sofa-sync': '0 12 * * *',
  'vulnerability-correlate': '0 13 * * *',
  'reliability-history-retention': '5 14 * * *',
  'playbook-execution-retention': '25 14 * * *',
  'cve-enrichment': '45 14 * * *',
  'winget-index-sync': '5 16 * * *',
  'sso-domain-recheck': '25 16 * * *',
  'exchange-rate-sync': '15 17 * * *',

  // ------------------------------------------------------------ sub-daily tier
  // One distinct minute-of-hour each, so the hourly and 6-hourly sweeps never
  // land together (they used to pile on :00 the same way the daily jobs piled
  // on 00:00).
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
