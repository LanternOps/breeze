import { describe, expect, it } from 'vitest';
import { formatCalendarDate } from './calendarDate';

/**
 * A `date` column ("2026-09-23") is a calendar day, not an instant. Passing it
 * to `new Date(...)` reads it as UTC midnight, so ANY formatter that then
 * renders in the viewer's zone prints the previous day everywhere west of UTC.
 *
 * That is not cosmetic on an SSR page: the Astro server (UTC in the container)
 * and the browser (the customer's zone) then disagree, React throws
 * "Hydration failed because the server rendered text didn't match the client"
 * and re-renders the tree. Caught in the W04 browser proof — the Service page
 * printed "Next due: Sep 23, 2026" on the server and "Sep 22, 2026" in a
 * Denver browser.
 */
describe('formatCalendarDate', () => {
  it('renders the same day the database stored, in every viewer zone', () => {
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Denver', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        expect(formatCalendarDate('2026-09-23')).toBe('Sep 23, 2026');
        expect(formatCalendarDate('2027-01-01')).toBe('Jan 1, 2027');
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it('passes a full timestamp through with the zone it was given', () => {
    expect(formatCalendarDate('2026-10-02T03:30:00.000Z', 'America/Denver')).toBe('Oct 1, 2026');
    expect(formatCalendarDate('2026-10-02T03:30:00.000Z', 'UTC')).toBe('Oct 2, 2026');
  });
});
