import { describe, it, expect } from 'vitest';
import { isReportOccurrenceDue, lastOccurrenceKey } from './reportScheduleWorker';
import { pgOffsetlessTimestamp } from '../testUtils/pgOffsetlessTimestamp';

/**
 * #4059 gap 2 — scheduled-report due detection on a non-UTC API host.
 *
 * `reports.last_generated_at` is `timestamp('last_generated_at')` with no
 * `withTimezone: true` (`db/schema/reports.ts:82`), so postgres.js hands
 * `findDueReports` a Date carrying the UTC wall clock re-read as the API
 * process's LOCAL time. `isDue` converts that Date to wall-clock parts in the
 * ORG's zone and compares it against the occurrence key, so without the
 * correction in `isReportOccurrenceDue` the comparison is wrong by the API
 * host's offset:
 *
 * - **East of UTC**: an occurrence that already ran reads as older than it is
 *   and re-fires → the same scheduled report is generated and emailed twice.
 * - **West of UTC**: an occurrence that has NOT run reads as newer than it is
 *   and is suppressed → a silently missed scheduled report.
 *
 * Same defect class as #4018 (gap 1 of this issue, PR #4878).
 *
 * **These assertions only have teeth under a non-UTC TZ**, which is the whole
 * point: `pgOffsetlessTimestamp` reproduces the driver's misparse using the
 * PROCESS's own zone, so under a UTC runner it is the identity function and
 * these cases collapse to trivially-true — exactly the vacuity #4046 exists to
 * prevent. That is why this file is registered in `vitest.config.tz.ts`
 * (`pnpm test:tz`, `TZ=America/Denver` in CI), guarded by
 * `__tests__/tzPinCanary.test.ts`. A fabricated arbitrary offset would NOT
 * work here: the production correction reads `getTimezoneOffset()` off the real
 * process, so only a real host offset can be recovered.
 *
 * Verified red against the pre-fix code under `TZ=America/Denver`.
 */

const TZ = 'UTC';
/** A daily 09:00 schedule; 2026-06-10T09:00Z is the occurrence boundary. */
const DAILY = { time: '09:00' } as const;
const NOW = new Date('2026-06-10T09:30:00Z');

const keyForNow = () => lastOccurrenceKey(NOW, 'daily', DAILY, TZ);

describe('isReportOccurrenceDue — offsetless last_generated_at (#4059)', () => {
  it('does not re-fire an occurrence that already ran', () => {
    // Genuinely ran at 09:05Z, five minutes AFTER the 09:00 occurrence.
    const ranAt = pgOffsetlessTimestamp(Date.parse('2026-06-10T09:05:00Z'));
    expect(isReportOccurrenceDue(ranAt, keyForNow(), TZ)).toBe(false);
  });

  it('still fires an occurrence that has not run yet', () => {
    // Genuinely ran at 08:55Z, five minutes BEFORE the 09:00 occurrence.
    const ranAt = pgOffsetlessTimestamp(Date.parse('2026-06-10T08:55:00Z'));
    expect(isReportOccurrenceDue(ranAt, keyForNow(), TZ)).toBe(true);
  });

  it('fires when the last run was the previous day', () => {
    const ranAt = pgOffsetlessTimestamp(Date.parse('2026-06-09T09:05:00Z'));
    expect(isReportOccurrenceDue(ranAt, keyForNow(), TZ)).toBe(true);
  });

  it('matches the verdict computed from the true instant, whatever the host zone', () => {
    // The invariant the correction exists to restore: a Date that came off the
    // wire must produce the same verdict as the true instant it represents.
    // `expectedVerdict` is derived from the ISO text independently of the
    // function under test, so this cannot be satisfied by the correction being
    // skipped (or applied twice) on both sides of an equality.
    for (const iso of [
      '2026-06-09T00:00:00Z',
      '2026-06-10T08:55:00Z',
      '2026-06-10T09:00:00Z',
      '2026-06-10T09:05:00Z',
      '2026-06-10T23:59:00Z',
    ]) {
      const ms = Date.parse(iso);
      expect(
        isReportOccurrenceDue(pgOffsetlessTimestamp(ms), keyForNow(), TZ),
        `offsetless parse of ${iso} must agree with its true instant`,
      ).toBe(expectedVerdict(iso));
    }
  });

  it('never ran is always due', () => {
    expect(isReportOccurrenceDue(null, keyForNow(), TZ)).toBe(true);
  });
});

/**
 * The due verdict for an instant, derived straight from its UTC ISO text
 * (the occurrence key is `YYYYMMDDHHmm` in the schedule's zone, which is UTC
 * in these fixtures). Independent of the production code path.
 */
function expectedVerdict(iso: string): boolean {
  const asKey = Number(
    `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}`,
  );
  return asKey < keyForNow();
}
