import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #5104: TimesheetScreen.tsx cannot be rendered under this project's vitest
// runtime (see MfaChallengeScreen.test.ts's comment — no React Native test
// runtime is configured), so this reads the real shipped source. Two bugs:
//   1. The header rendered `view.totals` unconditionally, so it read "0m
//      total · 0m billable" while the body below was still showing a
//      spinner for THIS week's fetch (view.totals off an empty array before
//      `entries` loads is indistinguishable from a genuinely empty week).
//   2. Days rendered Monday-first, so on a mid-to-late week (Wed/Thu/...)
//      today's entries sat below the fold without scrolling.

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'TimesheetScreen.tsx'),
  'utf8'
);

describe('TimesheetScreen header + day order (#5104)', () => {
  it('does not render the week totals until entries have loaded for this week', () => {
    const totalsUse = source.indexOf('view.totals.totalMinutes');
    expect(totalsUse, 'expected the header to still read view.totals somewhere').toBeGreaterThanOrEqual(0);

    // The nearest preceding `entries === null` guard within the same JSX
    // expression is what makes the placeholder conditional rather than the
    // totals rendering unconditionally.
    const guardBefore = source.lastIndexOf('entries === null', totalsUse);
    expect(
      guardBefore,
      'expected an `entries === null` guard before the totals are rendered, gating them on the week having actually loaded'
    ).toBeGreaterThanOrEqual(0);

    // The guard and the totals use must belong to the same JSX expression —
    // bound the search to the nearest `</Text>` after the guard so a stale,
    // unrelated `entries === null` elsewhere in the file (e.g. the spinner
    // phase check) can't satisfy this test vacuously.
    const closingText = source.indexOf('</Text>', guardBefore);
    expect(closingText).toBeGreaterThan(totalsUse);
  });

  it('renders the week most-recent-day-first', () => {
    expect(source).toContain('days.slice().reverse().map(');
  });
});
