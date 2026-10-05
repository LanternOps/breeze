// retryDates.test.ts
import { expect, it } from 'vitest';
import { retryAt } from './retryDates';
it('anchors card retries on first attempt, not failure arrival', () => {
  const first = new Date('2026-10-01T15:00:00Z');
  expect(retryAt(first, new Date('2026-10-05T12:00Z'), 'soft', 1)?.toISOString()).toBe('2026-10-04T15:00:00.000Z');
  expect(retryAt(first, first, 'soft', 2)?.toISOString()).toBe('2026-10-08T15:00:00.000Z');
  expect(retryAt(first, first, 'soft', 3)).toBeNull();
});
it('skips weekends and Columbus Day for ACH', () => {
  const failed = new Date('2026-10-09T15:00Z');
  expect(retryAt(failed, failed, 'nsf', 1)?.toISOString()).toBe('2026-10-15T15:00:00.000Z');
  expect(retryAt(failed, failed, 'nsf', 2)).toBeNull();
});
it('never retries authentication or revoked authorization', () => {
  for (const kind of ['auth_required', 'revoked', 'hard'] as const) {
    expect(retryAt(new Date(), new Date(), kind, 1)).toBeNull();
  }
});

it.each([
  ['2026-01-16', '2026-01-22'], // MLK Day
  ['2026-02-13', '2026-02-19'], // Washington's Birthday
  ['2026-05-22', '2026-05-28'], // Memorial Day
  ['2026-06-18', '2026-06-24'], // Juneteenth
  ['2026-07-02', '2026-07-07'], // Saturday July 4 does not close Friday
  ['2026-09-04', '2026-09-10'], // Labor Day
  ['2026-11-10', '2026-11-16'], // Veterans Day
  ['2026-11-25', '2026-12-01'], // Thanksgiving
  ['2026-12-24', '2026-12-30'], // Christmas
  ['2026-12-31', '2027-01-06'], // New Year across the year boundary
  ['2027-07-02', '2027-07-08'], // Sunday July 4 closes Monday
])('counts three banking days from %s to %s in UTC', (failed, expected) => {
  const failure = new Date(`${failed}T15:12:34.567Z`);
  const original = failure.getTime();
  expect(retryAt(new Date('2025-01-01'), failure, 'nsf', 1)?.toISOString()).toBe(`${expected}T15:12:34.567Z`);
  expect(failure.getTime()).toBe(original);
});
it('bounds exhausted attempts and does not mutate the first attempt', () => {
  const first = new Date('2026-12-30T15:00:00Z');
  expect(retryAt(first, first, 'soft', 2)?.toISOString()).toBe('2027-01-06T15:00:00.000Z');
  expect(first.toISOString()).toBe('2026-12-30T15:00:00.000Z');
  expect(retryAt(first, first, 'soft', 4)).toBeNull();
  expect(retryAt(first, first, 'nsf', 3)).toBeNull();
});
