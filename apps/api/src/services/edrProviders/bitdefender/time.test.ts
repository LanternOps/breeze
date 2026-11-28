import { describe, expect, it } from 'vitest';
import { parseGzDate } from './time';

const NY = 'America/New_York';

describe('parseGzDate (#12821)', () => {
  // Live pairs, read 2026-11-27 from one endpoint at the same moment with both key types:
  // a personal key answers in its owner's account timezone (here America/New_York),
  // a service key answers in UTC. Both must land on the same instant.
  it.each([
    ['lastSeen, winter (EST, -5)', '2026-11-27T17:17:34', '2026-11-27T22:17:34', '2026-11-27T22:17:34.000Z'],
    ['firstSeen, summer (EDT, -4)', '2026-10-08T12:56:51', '2026-10-08T16:56:51', '2026-10-08T16:56:51.000Z'],
    ['agent.lastUpdate', '2026-11-27T14:44:34', '2026-11-27T19:44:34', '2026-11-27T19:44:34.000Z'],
  ])('%s: personal key in the owner zone and service key in UTC give one instant', (_label, personal, service, iso) => {
    expect(parseGzDate(personal, NY)?.toISOString()).toBe(iso);
    expect(parseGzDate(service, 'UTC')?.toISOString()).toBe(iso);
  });

  it('an offset-less time with no known zone is null, never guessed as UTC', () => {
    expect(parseGzDate('2026-11-27T17:17:34', null)).toBeNull();
  });

  it('an explicit offset wins over the zone, and needs no zone (the incidents API sends one)', () => {
    expect(parseGzDate('2026-11-25T16:26:45-05:00', null)?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
    expect(parseGzDate('2026-11-25T21:26:45+00:00', 'Asia/Tokyo')?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
    expect(parseGzDate('2026-11-25T21:26:45Z', null)?.toISOString()).toBe('2026-11-25T21:26:45.000Z');
  });

  it('keeps seconds and fractions, accepts a space separator and minute precision', () => {
    expect(parseGzDate('2026-11-27 17:17:34.250', NY)?.toISOString()).toBe('2026-11-27T22:17:34.250Z');
    expect(parseGzDate('2026-11-27T17:17', NY)?.toISOString()).toBe('2026-11-27T22:17:00.000Z');
  });

  it('a zone east of UTC moves the other way, half-hour offsets included', () => {
    expect(parseGzDate('2026-11-28T07:17:34', 'Asia/Tokyo')?.toISOString()).toBe('2026-11-27T22:17:34.000Z');
    expect(parseGzDate('2026-11-28T03:47:34', 'Asia/Kolkata')?.toISOString()).toBe('2026-11-27T22:17:34.000Z');
  });

  it('DST fall-back: the repeated hour resolves to its first occurrence (the earlier instant)', () => {
    // 2026-11-01 01:30 happens twice in New York: 05:30Z (EDT) and 06:30Z (EST).
    expect(parseGzDate('2026-11-01T01:30:00', NY)?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(parseGzDate('2026-11-01T02:30:00', NY)?.toISOString()).toBe('2026-11-01T07:30:00.000Z');
    expect(parseGzDate('2026-11-01T00:59:59', NY)?.toISOString()).toBe('2026-11-01T04:59:59.000Z');
  });

  it('DST fall-back east of UTC also takes the first occurrence (review: the shared helper takes the second there)', () => {
    // 2026-10-25 02:30 happens twice in Berlin: 00:30Z (CEST, +2) and 01:30Z (CET, +1).
    expect(parseGzDate('2026-10-25T02:30:00', 'Europe/Berlin')?.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(parseGzDate('2026-10-25T03:00:00', 'Europe/Berlin')?.toISOString()).toBe('2026-10-25T02:00:00.000Z');
    // Spring-forward east of UTC: 02:30 is skipped on 2026-03-29 and reads as 03:30 CEST.
    expect(parseGzDate('2026-03-29T02:30:00', 'Europe/Berlin')?.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('DST spring-forward: a skipped wall time moves forward into the new offset', () => {
    // 02:30 does not exist in New York on 2026-03-08; it reads as 03:30 EDT.
    expect(parseGzDate('2026-03-08T02:30:00', NY)?.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(parseGzDate('2026-03-08T03:00:00', NY)?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('an unknown zone name is null, never a fallback to UTC', () => {
    expect(parseGzDate('2026-11-27T17:17:34', 'Mars/Olympus_Mons')).toBeNull();
    expect(parseGzDate('2026-11-27T17:17:34', '')).toBeNull();
  });

  it('empty, malformed and impossible values are null', () => {
    for (const v of [undefined, null, '', '   ', 'yesterday', '2026-13-01T00:00:00', '2026-02-30T00:00:00', 42, {}, true]) {
      expect(parseGzDate(v, NY)).toBeNull();
    }
  });
});
