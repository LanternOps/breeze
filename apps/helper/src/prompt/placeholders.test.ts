import { describe, expect, it } from 'vitest';

import { applyPlaceholders } from './placeholders';

// 2026-10-26 14:30:00 local time, so "same day" is stable in any TZ.
const NOW = new Date(2026, 9, 26, 14, 30, 0).getTime();
const LATER_TODAY = new Date(2026, 9, 26, 15, 30, 0).getTime();
const NEXT_WEEK = new Date(2026, 10, 2, 9, 5, 0).getTime();

const timeOnly = (ms: number, locale = 'en') =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

describe('applyPlaceholders', () => {
  it('replaces {remaining} with the live M:SS countdown', () => {
    expect(applyPlaceholders('Time left: {remaining}.', NOW, 'en', NOW + 125_000)).toBe('Time left: 2:05.');
    expect(applyPlaceholders('{remaining} / {remaining}', NOW, 'en', NOW + 1_000)).toBe('0:01 / 0:01');
    // Past the deadline it floors at 0:00, never negative.
    expect(applyPlaceholders('{remaining}', NOW, 'en', NOW - 10_000)).toBe('0:00');
  });

  it('formats {time:<unixMs>} in the prompt locale, with the date when it is not today', () => {
    expect(applyPlaceholders(`Postpone until {time:${LATER_TODAY}}`, NOW, 'en')).toBe(
      `Postpone until ${timeOnly(LATER_TODAY)}`,
    );
    expect(applyPlaceholders(`at {time:${LATER_TODAY}}`, NOW, 'de-DE')).toBe(`at ${timeOnly(LATER_TODAY, 'de-DE')}`);
    const nextWeek = applyPlaceholders(`{time:${NEXT_WEEK}}`, NOW, 'en');
    expect(nextWeek).toContain(timeOnly(NEXT_WEEK));
    expect(nextWeek).not.toBe(timeOnly(NEXT_WEEK));
  });

  it('applyPlaceholders leaves {{countdown}} and unknown braces literal', () => {
    const operator = 'Restart in {{countdown}}. Again: {{countdown}}. {{x}} {remainder} {time:} {time:abc} {}';
    expect(applyPlaceholders(operator, NOW, 'en', NOW + 60_000)).toBe(operator);
    // A renderer token wrapped in operator double braces is not a token.
    expect(applyPlaceholders('{{remaining}} {{time:1}}', NOW, 'en', NOW + 60_000)).toBe('{{remaining}} {{time:1}}');
    // A {remaining} with no deadline is left as is rather than invented.
    expect(applyPlaceholders('Time left: {remaining}', NOW, 'en')).toBe('Time left: {remaining}');
    expect(applyPlaceholders('{remaining}', NOW, 'en', null)).toBe('{remaining}');
    // Out-of-range times are not formatted.
    expect(applyPlaceholders('{time:99999999999999999}', NOW, 'en')).toBe('{time:99999999999999999}');
    // Newlines and markup characters pass through untouched (rendered as text).
    expect(applyPlaceholders('<b>a</b>\n{', NOW, 'en')).toBe('<b>a</b>\n{');
  });

  it('never rescans what it substituted', () => {
    // The countdown text cannot form a new token with its neighbours.
    expect(applyPlaceholders('{{remaining}}}', NOW, 'en', NOW + 1_000)).toBe('{{remaining}}}');
    expect(applyPlaceholders('{{remaining}', NOW, 'en', NOW + 1_000)).toBe('{{remaining}');
  });

  it('falls back to en for a locale Intl does not accept', () => {
    expect(applyPlaceholders(`{time:${LATER_TODAY}}`, NOW, 'not a locale!')).toBe(timeOnly(LATER_TODAY, 'en'));
  });
});
