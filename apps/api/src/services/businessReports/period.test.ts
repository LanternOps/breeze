import { beforeEach, describe, expect, it, vi } from 'vitest';

const { systemCtxSpy, ambient } = vi.hoisted(() => ({
  systemCtxSpy: vi.fn(),
  ambient: { current: undefined as unknown },
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(() => {
    throw new Error('runOutsideDbContext must never be called from businessReports code (#3198 W02 ruling P6)');
  }),
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => { systemCtxSpy(); return fn(); },
  getCurrentDbAccessContext: () => ambient.current,
  hasDbAccessContext: () => ambient.current !== undefined,
}));

const resolveOrgTimezoneMock = vi.fn(async (_orgId: string) => 'org-tz-result');
const resolvePartnerTimezoneMock = vi.fn(async (_partnerId: string) => 'partner-tz-result');
vi.mock('../portal/timezone', () => ({
  resolveOrgTimezone: (orgId: string) => resolveOrgTimezoneMock(orgId),
  resolvePartnerTimezone: (partnerId: string) => resolvePartnerTimezoneMock(partnerId),
}));

import { resolveReportOwnerTimezone, resolveReportPeriod, workingDaysBetween } from './period';
import { ReportScopeMismatchError } from '../reportScope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const PARTNER = '44444444-4444-4444-8444-444444444444';

const NOW = new Date('2026-09-21T13:45:00.000Z'); // a Monday

describe('resolveReportPeriod', () => {
  it('last_full_month is the previous calendar month in the given zone, end-exclusive', () => {
    const p = resolveReportPeriod({ kind: 'last_full_month' }, 'America/Chicago', NOW);
    expect(p.start.toISOString()).toBe('2026-08-01T05:00:00.000Z'); // Aug 1 00:00 CDT
    expect(p.end.toISOString()).toBe('2026-09-01T05:00:00.000Z'); // Sep 1 00:00 CDT
    expect(p.label).toBe('August 2026');
  });

  it('the SAME instant in a different zone gives a different window', () => {
    const p = resolveReportPeriod({ kind: 'last_full_month' }, 'Australia/Sydney', NOW);
    expect(p.start.toISOString()).toBe('2026-07-31T14:00:00.000Z'); // Aug 1 00:00 AEST
  });

  it('last_30_days ends at the start of today in the zone and spans 30 days', () => {
    const p = resolveReportPeriod({ kind: 'last_30_days' }, 'UTC', NOW);
    expect(p.end.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(p.start.toISOString()).toBe('2026-08-22T00:00:00.000Z');
    expect(p.label).toBe('Last 30 days');
  });

  it('last_30_days steps 30 ZONED days across a DST change — both ends at local midnight', () => {
    // America/Chicago leaves CDT (UTC-5) for CST (UTC-6) on 2026-11-01.
    const p = resolveReportPeriod({ kind: 'last_30_days' }, 'America/Chicago', new Date('2026-11-15T18:00:00Z'));
    expect(p.end.toISOString()).toBe('2026-11-15T06:00:00.000Z'); // Nov 15 00:00 CST
    expect(p.start.toISOString()).toBe('2026-10-16T05:00:00.000Z'); // Oct 16 00:00 CDT, not 01:00
  });

  it('last_30_days across the spring-forward change (2026-03-08) also lands on local midnight', () => {
    const p = resolveReportPeriod({ kind: 'last_30_days' }, 'America/Chicago', new Date('2026-03-20T18:00:00Z'));
    expect(p.end.toISOString()).toBe('2026-03-20T05:00:00.000Z'); // Mar 20 00:00 CDT
    expect(p.start.toISOString()).toBe('2026-02-18T06:00:00.000Z'); // Feb 18 00:00 CST
  });

  it('last_quarter is the previous CALENDAR quarter', () => {
    const p = resolveReportPeriod({ kind: 'last_quarter' }, 'UTC', NOW);
    expect(p.start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(p.label).toBe('Q2 2026');
  });

  it('custom takes the given dates in the zone, end-exclusive at the NEXT midnight', () => {
    const p = resolveReportPeriod({ kind: 'custom', start: '2026-03-01', end: '2026-03-15' }, 'UTC', NOW);
    expect(p.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(p.label).toBe('2026-03-01 to 2026-03-15');
  });

  it('custom with a missing or inverted range falls back to last_full_month rather than querying everything', () => {
    expect(resolveReportPeriod({ kind: 'custom' }, 'UTC', NOW).kind).toBe('last_full_month');
    expect(resolveReportPeriod({ kind: 'custom', start: '2026-03-15', end: '2026-03-01' }, 'UTC', NOW).kind)
      .toBe('last_full_month');
  });

  it('an absent config period defaults to last_full_month (spec §3.3 R1)', () => {
    expect(resolveReportPeriod(undefined, 'UTC', NOW).kind).toBe('last_full_month');
  });

  it('an unknown timezone degrades to UTC instead of throwing mid-generation', () => {
    expect(resolveReportPeriod({ kind: 'last_30_days' }, 'Mars/Olympus', NOW).timeZone).toBe('UTC');
  });
});

describe('resolveReportOwnerTimezone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ambient.current = undefined;
  });

  it('an org owner with no ambient context resolves via resolveOrgTimezone under a system context', async () => {
    const tz = await resolveReportOwnerTimezone({ orgId: ORG_A });
    expect(tz).toBe('org-tz-result');
    expect(resolveOrgTimezoneMock).toHaveBeenCalledWith(ORG_A);
    expect(systemCtxSpy).toHaveBeenCalledTimes(1);
  });

  it('a partner owner with no ambient context resolves via resolvePartnerTimezone under a system context', async () => {
    const tz = await resolveReportOwnerTimezone({ partnerId: PARTNER });
    expect(tz).toBe('partner-tz-result');
    expect(resolvePartnerTimezoneMock).toHaveBeenCalledWith(PARTNER);
    expect(systemCtxSpy).toHaveBeenCalledTimes(1);
  });

  it('an org owner reached under an ambient context that can already see the org runs IN it, opening no system context', async () => {
    ambient.current = { scope: 'organization', accessibleOrgIds: [ORG_A] };
    const tz = await resolveReportOwnerTimezone({ orgId: ORG_A });
    expect(tz).toBe('org-tz-result');
    expect(systemCtxSpy).not.toHaveBeenCalled();
  });

  it('a partner owner reached under an ambient context that cannot see the partner throws rather than silently zeroing', async () => {
    ambient.current = { scope: 'organization', accessibleOrgIds: [] };
    await expect(resolveReportOwnerTimezone({ partnerId: PARTNER })).rejects.toThrow(ReportScopeMismatchError);
    expect(resolvePartnerTimezoneMock).not.toHaveBeenCalled();
  });

  it('never calls runOutsideDbContext (#3198 W02 ruling P6)', async () => {
    await resolveReportOwnerTimezone({ orgId: ORG_A });
    await resolveReportOwnerTimezone({ partnerId: PARTNER });
    // The mock throws if invoked; reaching here without a thrown error proves it.
  });
});

describe('workingDaysBetween', () => {
  it('counts Mon-Fri in the zone over a half-open range', () => {
    // 2026-08-01 .. 2026-09-01 exclusive: August 2026 has 21 weekdays.
    expect(workingDaysBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 'UTC')).toBe(21);
  });
  it('a single weekend day is zero', () => {
    expect(workingDaysBetween(new Date('2026-09-19T00:00:00Z'), new Date('2026-09-21T00:00:00Z'), 'UTC')).toBe(0);
  });
  it('never returns a negative count', () => {
    expect(workingDaysBetween(new Date('2026-09-21T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 'UTC')).toBe(0);
  });
});
