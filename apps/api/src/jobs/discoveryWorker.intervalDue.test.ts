import { describe, it, expect } from 'vitest';
import { isIntervalScheduleDue } from './discoveryWorker';
import { pgOffsetlessTimestamp } from '../testUtils/pgOffsetlessTimestamp';

/**
 * #4059 gap 2 — interval-scheduled network discovery on a non-UTC API host.
 *
 * `discovery_jobs.scheduled_at` and `.created_at` are `timestamp(...)` columns
 * with no `withTimezone: true` (`db/schema/discovery.ts:132,139`), so
 * postgres.js hands back the UTC wall clock re-read as this process's LOCAL
 * time. The interval branch of `processScheduleProfiles` subtracts that Date's
 * `getTime()` from a true-instant `now`, so the elapsed interval is off by the
 * host's offset:
 *
 * - **West of UTC** (e.g. America/Denver, UTC-6): the last run reads ~6h more
 *   recent than it was, so a 60-minute interval profile stops firing entirely
 *   until 6h of real time have passed — discovery silently goes quiet.
 * - **East of UTC**: the last run reads older than it was, so the profile
 *   fires early and re-scans more often than configured.
 *
 * Same defect class as #4018 and gap 1 of this issue (PR #4878).
 *
 * **These assertions only have teeth under a non-UTC TZ.** `pgOffsetlessTimestamp`
 * reproduces the driver misparse using the PROCESS's own zone, so under a UTC
 * runner it is the identity function and the offset cases collapse to trivially
 * true — precisely the vacuity #4046 exists to prevent. Hence this file's
 * registration in `vitest.config.tz.ts` (`pnpm test:tz`, `TZ=America/Denver`),
 * guarded by `__tests__/tzPinCanary.test.ts`.
 *
 * Verified red against the pre-fix code under `TZ=America/Denver`.
 */

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-06-10T12:00:00Z');
/** A 60-minute interval profile. */
const THRESHOLD = 60 * 60 * 1000;

describe('isIntervalScheduleDue — offsetless discovery_jobs timestamps (#4059)', () => {
  it('is due when the last run is older than the interval', () => {
    // Genuinely ran 90 minutes ago.
    const last = pgOffsetlessTimestamp(NOW.getTime() - 1.5 * HOUR);
    expect(isIntervalScheduleDue(last, NOW, THRESHOLD)).toBe(true);
  });

  it('is not due when the last run is inside the interval', () => {
    // Genuinely ran 30 minutes ago.
    const last = pgOffsetlessTimestamp(NOW.getTime() - 0.5 * HOUR);
    expect(isIntervalScheduleDue(last, NOW, THRESHOLD)).toBe(false);
  });

  it('is due exactly at the interval boundary', () => {
    const last = pgOffsetlessTimestamp(NOW.getTime() - THRESHOLD);
    expect(isIntervalScheduleDue(last, NOW, THRESHOLD)).toBe(true);
  });

  it('a profile that has never run is always due', () => {
    expect(isIntervalScheduleDue(null, NOW, THRESHOLD)).toBe(true);
  });

  it('elapsed time is the true elapsed time, whatever the host zone', () => {
    // The invariant the correction restores: the measured gap must equal the
    // real one. Asserted across a range so a partial correction cannot pass.
    for (const elapsedMinutes of [0, 15, 59, 60, 61, 120, 24 * 60]) {
      const last = pgOffsetlessTimestamp(NOW.getTime() - elapsedMinutes * 60_000);
      expect(
        isIntervalScheduleDue(last, NOW, THRESHOLD),
        `${elapsedMinutes} minutes elapsed against a 60-minute interval`,
      ).toBe(elapsedMinutes >= 60);
    }
  });
});
