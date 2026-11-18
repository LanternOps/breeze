import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFilterParams, computeDateRange, hasActiveFilters, type ActiveFilters } from './auditFilterParams';

const base: ActiveFilters = { datePreset: 'custom', actions: [], resources: [], search: '' };

// Node re-reads process.env.TZ on assignment, so each test can pin a zone.
const originalTz = process.env.TZ;
function useTimeZone(tz: string) {
  process.env.TZ = tz;
}

describe('computeDateRange custom range = the user\'s local day start/end (#9670)', () => {
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('control: the pinned zone actually took effect', () => {
    useTimeZone('America/Chicago');
    // CDT is UTC-5 on 2026-10-20.
    expect(new Date(2026, 9, 20).getTimezoneOffset()).toBe(300);
    useTimeZone('Asia/Tokyo');
    expect(new Date(2026, 9, 20).getTimezoneOffset()).toBe(-540);
  });

  it('west of UTC (America/Chicago): Tuesday..Tuesday covers all of local Tuesday', () => {
    useTimeZone('America/Chicago');
    const range = computeDateRange({ ...base, startDate: '2026-10-20', endDate: '2026-10-20' });
    expect(range).toEqual({
      from: '2026-10-20T05:00:00.000Z',
      to: '2026-10-21T04:59:59.999Z'
    });
  });

  it('east of UTC (Asia/Tokyo): the window starts at local midnight, not 09:00', () => {
    useTimeZone('Asia/Tokyo');
    const range = computeDateRange({ ...base, startDate: '2026-10-20', endDate: '2026-10-20' });
    expect(range).toEqual({
      from: '2026-10-19T15:00:00.000Z',
      to: '2026-10-20T14:59:59.999Z'
    });
  });

  it('UTC: midnight to 23:59:59.999 of the same date', () => {
    useTimeZone('UTC');
    expect(computeDateRange({ ...base, startDate: '2026-10-20', endDate: '2026-10-22' })).toEqual({
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-22T23:59:59.999Z'
    });
  });

  it('a DST-change day uses that day\'s own offset (America/Chicago, 2026-11-01 is 25h)', () => {
    useTimeZone('America/Chicago');
    expect(computeDateRange({ ...base, startDate: '2026-11-01', endDate: '2026-11-01' })).toEqual({
      from: '2026-11-01T05:00:00.000Z', // 00:00 CDT
      to: '2026-11-02T05:59:59.999Z' // 23:59:59.999 CST
    });
  });

  it('only one bound set: the other stays open', () => {
    useTimeZone('America/Chicago');
    expect(computeDateRange({ ...base, startDate: '2026-10-20' })).toEqual({ from: '2026-10-20T05:00:00.000Z' });
    expect(computeDateRange({ ...base, endDate: '2026-10-20' })).toEqual({ to: '2026-10-21T04:59:59.999Z' });
  });

  it('an unparseable date still throws, so the export surfaces its error toast', () => {
    expect(() => computeDateRange({ ...base, startDate: 'not-a-date' })).toThrow(RangeError);
    expect(() => computeDateRange({ ...base, endDate: '2026-13-45' })).toThrow(RangeError);
  });
});

describe('appendFilterParams user filter is by identity (#9671)', () => {
  let params: URLSearchParams;
  beforeEach(() => {
    params = new URLSearchParams();
  });

  it('a picked user sends userId and not the email text match', () => {
    appendFilterParams(params, {
      ...base,
      datePreset: '7d',
      userId: '11111111-1111-4111-8111-111111111111',
      userEmail: 'dana@example.com'
    });
    expect(params.get('userId')).toBe('11111111-1111-4111-8111-111111111111');
    expect(params.has('user')).toBe(false);
  });

  it('an email without an id still falls back to the text filter', () => {
    appendFilterParams(params, { ...base, datePreset: '7d', userEmail: 'dana@example.com' });
    expect(params.get('user')).toBe('dana@example.com');
    expect(params.has('userId')).toBe(false);
  });

  it('a picked user counts as an active filter', () => {
    expect(hasActiveFilters({ ...base, datePreset: '7d', userId: '11111111-1111-4111-8111-111111111111' })).toBe(true);
  });
});
