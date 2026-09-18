import { describe, expect, it } from 'vitest';
import { isStructurallyValidCron, nextCronOccurrence, nextCronOccurrenceAt, parseFiveFieldCron } from './cron';
describe('isStructurallyValidCron', () => {
  it.each(['0 6 * * 1-5', '*/15 * * * *', '0 0 6 * * *'])('accepts %s', (p) => expect(isStructurallyValidCron(p)).toBe(true));
  it.each(['', '0 6 * *', 'every morning', '60 6 * * *'])('rejects %s', (p) => expect(isStructurallyValidCron(p)).toBe(false));
});

// AI patch agent W01 (#5747) — these three moved here from
// `apps/web/.../AiAgentSchedulesSection.tsx` so the agents LIST ROUTE and the
// schedules drawer evaluate one implementation and can never disagree about
// when an agent next fires.
describe('parseFiveFieldCron', () => {
  it('expands lists, ranges, steps and day names', () => {
    const fields = parseFiveFieldCron('0,30 1-3 * * mon');
    expect(fields).not.toBeNull();
    expect([...fields!.minutes]).toEqual([0, 30]);
    expect([...fields!.hours]).toEqual([1, 2, 3]);
    expect([...fields!.daysOfWeek]).toEqual([1]);
    expect(fields!.dowRestricted).toBe(true);
    expect(fields!.domRestricted).toBe(false);
  });
  it('folds day 7 onto Sunday', () => {
    expect([...parseFiveFieldCron('0 3 * * 7')!.daysOfWeek]).toEqual([0]);
  });
  it('returns null for a non-five-field or unparseable pattern', () => {
    expect(parseFiveFieldCron('0 3 * *')).toBeNull();
    expect(parseFiveFieldCron('0 3 * * nope')).toBeNull();
  });
});

describe('nextCronOccurrence', () => {
  const at = (iso: string) => Date.parse(iso);
  const next = (cron: string, fromIso: string) => {
    const fields = parseFiveFieldCron(cron);
    return fields ? nextCronOccurrence(fields, at(fromIso))?.toISOString() ?? null : null;
  };
  it('finds the next daily occurrence strictly after "now"', () => {
    expect(next('0 2 * * *', '2026-09-14T02:00:00Z')).toBe('2026-09-15T02:00:00.000Z');
    expect(next('0 2 * * *', '2026-09-14T01:59:00Z')).toBe('2026-09-14T02:00:00.000Z');
  });
  it('honours the Vixie either-or day rule when both day fields are restricted', () => {
    // 2026-09-15 is a Tuesday; day-of-month 20 also matches.
    expect(next('0 2 20 * 2', '2026-09-14T03:00:00Z')).toBe('2026-09-15T02:00:00.000Z');
  });
  it('returns null for a pattern that never fires', () => {
    expect(next('0 0 30 2 *', '2026-09-14T00:00:00Z')).toBeNull();
  });
});

describe('nextCronOccurrenceAt', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  it('returns an ISO instant in the schedule timezone', () => {
    // 02:00 America/New_York on 2026-09-15 == 06:00Z (EDT, UTC-4).
    expect(nextCronOccurrenceAt('0 2 * * *', 'America/New_York', now)).toBe('2026-09-15T06:00:00.000Z');
  });
  it('treats UTC schedules as plain UTC', () => {
    expect(nextCronOccurrenceAt('0 2 * * *', 'UTC', now)).toBe('2026-09-15T02:00:00.000Z');
  });
  it('returns null rather than throwing for an unparseable cron', () => {
    expect(nextCronOccurrenceAt('every night', 'UTC', now)).toBeNull();
  });
  it('returns null for a pattern that never fires', () => {
    expect(nextCronOccurrenceAt('0 0 30 2 *', 'UTC', now)).toBeNull();
  });
  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    expect(nextCronOccurrenceAt('0 2 * * *', 'Mars/Olympus', now)).toBe('2026-09-15T02:00:00.000Z');
  });
});
