import { describe, expect, it } from 'vitest';
import {
  applyBusinessCalendarRevisionSchema,
  businessCalendarHolidaySchema,
  createBusinessCalendarSchema,
  orgBusinessCalendarOverrideSchema,
  updateBusinessCalendarSchema,
} from './businessCalendars';

const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 }));
const valid = { ownerScope: 'partner' as const, name: 'Support hours', timezone: 'Europe/London', intervals: weekdays };

describe('createBusinessCalendarSchema', () => {
  it('accepts a partner-wide calendar and an org-owned one with an orgId', () => {
    expect(createBusinessCalendarSchema.safeParse(valid).success).toBe(true);
    expect(createBusinessCalendarSchema.safeParse({
      ...valid, ownerScope: 'organization', orgId: '11111111-1111-4111-8111-111111111111',
    }).success).toBe(true);
  });

  it('accepts split shifts on one weekday', () => {
    const split = [{ weekday: 1, startMinute: 480, endMinute: 720 }, { weekday: 1, startMinute: 780, endMinute: 1020 }];
    expect(createBusinessCalendarSchema.safeParse({ ...valid, intervals: split }).success).toBe(true);
  });

  it('accepts optional holidays', () => {
    const r = createBusinessCalendarSchema.safeParse({ ...valid, holidays: [{ date: '2030-12-25', name: 'Christmas' }] });
    expect(r.success).toBe(true);
  });

  it.each([
    ['no intervals', { intervals: [] }],
    ['an overlap on one weekday', { intervals: [{ weekday: 1, startMinute: 540, endMinute: 720 }, { weekday: 1, startMinute: 700, endMinute: 900 }] }],
    ['start >= end', { intervals: [{ weekday: 1, startMinute: 600, endMinute: 600 }] }],
    ['end past midnight', { intervals: [{ weekday: 1, startMinute: 600, endMinute: 1441 }] }],
    ['weekday 7', { intervals: [{ weekday: 7, startMinute: 0, endMinute: 60 }] }],
    ['a fractional minute', { intervals: [{ weekday: 1, startMinute: 0.5, endMinute: 60 }] }],
    ['an unknown time zone', { timezone: 'Mars/Phobos' }],
    ['a blank name', { name: '   ' }],
    ['a 101-character name', { name: 'x'.repeat(101) }],
    ['orgId with ownerScope partner', { orgId: '11111111-1111-4111-8111-111111111111' }],
    ['an organization calendar without orgId', { ownerScope: 'organization' }],
    ['duplicate holiday dates', { holidays: [{ date: '2030-01-01', name: 'a' }, { date: '2030-01-01', name: 'b' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(createBusinessCalendarSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe('updateBusinessCalendarSchema', () => {
  it('is partial and cannot change the owner', () => {
    expect(updateBusinessCalendarSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(updateBusinessCalendarSchema.safeParse({ timezone: 'UTC', intervals: weekdays }).success).toBe(true);
    const stripped = updateBusinessCalendarSchema.safeParse({ name: 'x', ownerScope: 'organization', orgId: '11111111-1111-4111-8111-111111111111' });
    expect(stripped.success).toBe(true);
    expect(stripped.success && 'ownerScope' in stripped.data).toBe(false);
    expect(stripped.success && 'orgId' in stripped.data).toBe(false);
  });

  it('rejects an empty body and an hours edit that names only half the revision', () => {
    expect(updateBusinessCalendarSchema.safeParse({}).success).toBe(false);
    expect(updateBusinessCalendarSchema.safeParse({ timezone: 'UTC' }).success).toBe(false);
    expect(updateBusinessCalendarSchema.safeParse({ intervals: weekdays }).success).toBe(false);
  });

  it('rejects overlapping intervals', () => {
    const overlap = [{ weekday: 2, startMinute: 0, endMinute: 600 }, { weekday: 2, startMinute: 300, endMinute: 900 }];
    expect(updateBusinessCalendarSchema.safeParse({ timezone: 'UTC', intervals: overlap }).success).toBe(false);
  });
});

describe('businessCalendarHolidaySchema', () => {
  it('accepts YYYY-MM-DD and a name up to 100 characters', () => {
    expect(businessCalendarHolidaySchema.safeParse({ date: '2030-07-04', name: 'x'.repeat(100) }).success).toBe(true);
  });

  it.each(['2030-7-4', '07/04/2030', '2030-02-30', '2030-13-01'])('rejects date %s', (date) => {
    expect(businessCalendarHolidaySchema.safeParse({ date, name: 'Holiday' }).success).toBe(false);
  });

  it('rejects a blank or 101-character name', () => {
    expect(businessCalendarHolidaySchema.safeParse({ date: '2030-07-04', name: ' ' }).success).toBe(false);
    expect(businessCalendarHolidaySchema.safeParse({ date: '2030-07-04', name: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('orgBusinessCalendarOverrideSchema / applyBusinessCalendarRevisionSchema', () => {
  it('takes a calendar id or null (inherit)', () => {
    expect(orgBusinessCalendarOverrideSchema.safeParse({ calendarId: null }).success).toBe(true);
    expect(orgBusinessCalendarOverrideSchema.safeParse({ calendarId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(orgBusinessCalendarOverrideSchema.safeParse({}).success).toBe(false);
  });

  it('apply-revision requires the expected revision id', () => {
    expect(applyBusinessCalendarRevisionSchema.safeParse({ expectedRevisionId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    expect(applyBusinessCalendarRevisionSchema.safeParse({}).success).toBe(false);
  });
});
