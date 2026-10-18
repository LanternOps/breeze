import { describe, expect, it } from 'vitest';
import {
  includeOpenIncident,
  isDigestHour,
  localAgeDays,
  localClock,
  planUserDigest,
  sortForDigest,
  type DigestIncident,
} from './digestPlan';

const inc = (over: Partial<DigestIncident> = {}): DigestIncident => ({
  id: over.id ?? 'i1',
  orgId: null,
  orgName: null,
  displayName: 'Huntress',
  condition: 'sync_failed',
  severity: 'transient',
  detail: null,
  fixHref: '/integrations#huntress',
  openedAt: new Date('2026-10-14T12:00:00Z'),
  resolvedAt: null,
  resolution: null,
  ...over,
});

describe('localClock', () => {
  it('reads the partner-local date, hour and weekday', () => {
    // 2026-10-16 is a Friday. 12:09Z is 08:09 in New York (EDT, UTC-4).
    expect(localClock(new Date('2026-10-16T12:09:00Z'), 'America/New_York')).toEqual({ date: '2026-10-16', hour: 8, weekday: 5 });
  });

  it('crosses the date line', () => {
    // 22:09Z on Friday is 08:09 Saturday in Sydney (AEDT, UTC+11).
    expect(localClock(new Date('2026-10-16T21:09:00Z'), 'Australia/Sydney')).toEqual({ date: '2026-10-17', hour: 8, weekday: 6 });
  });

  it('falls back to UTC for an invalid or empty timezone', () => {
    expect(localClock(new Date('2026-10-16T08:09:00Z'), 'Not/AZone')).toEqual({ date: '2026-10-16', hour: 8, weekday: 5 });
    expect(localClock(new Date('2026-10-16T08:09:00Z'), '')).toEqual({ date: '2026-10-16', hour: 8, weekday: 5 });
  });

  it.each([
    ['America/New_York', '2026-03-08'], // spring forward
    ['America/New_York', '2026-11-01'], // fall back
    ['Asia/Kolkata', '2026-10-16'], // +05:30
    ['Asia/Kathmandu', '2026-10-16'], // +05:45
    ['Pacific/Chatham', '2026-10-16'], // +13:45
  ])('an hourly run at :09 hits local hour 8 exactly once on %s %s', (tz, day) => {
    const start = Date.parse(`${day}T00:09:00Z`) - 36 * 3600_000;
    let hits = 0;
    for (let h = 0; h < 72; h++) {
      const c = localClock(new Date(start + h * 3600_000), tz);
      if (c.date === day && c.hour === 8) hits += 1;
    }
    expect(hits).toBe(1);
  });
});

describe('isDigestHour (08:00–11:59 catch-up window)', () => {
  it.each([[7, false], [8, true], [11, true], [12, false], [0, false], [23, false]])('hour %i → %s', (h, want) => {
    expect(isDigestHour(h)).toBe(want);
  });
});

describe('localAgeDays', () => {
  it('counts partner-local calendar days, not 24h blocks', () => {
    // Opened 23:30 local on the 15th, now 08:00 local on the 16th → day 1.
    const tz = 'America/New_York';
    expect(localAgeDays(new Date('2026-10-16T03:30:00Z'), new Date('2026-10-16T12:00:00Z'), tz)).toBe(1);
    expect(localAgeDays(new Date('2026-10-16T05:00:00Z'), new Date('2026-10-16T12:00:00Z'), tz)).toBe(0);
  });

  it('is never negative', () => {
    expect(localAgeDays(new Date('2026-10-17T00:00:00Z'), new Date('2026-10-16T00:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('includeOpenIncident (decay: daily for 7 days, then Mondays)', () => {
  it.each([
    [0, 5, true],
    [6, 5, true],
    [7, 5, false],
    [7, 1, true],
    [30, 1, true],
    [30, 2, false],
    [30, 0, false],
  ])('age %i weekday %i → %s', (age, weekday, want) => {
    expect(includeOpenIncident(age, weekday)).toBe(want);
  });
});

describe('sortForDigest', () => {
  it('partner-wide first, then org name, then display name', () => {
    const rows = [
      inc({ id: 'b', orgId: 'o2', orgName: 'Beta', displayName: 'Z' }),
      inc({ id: 'a2', orgId: 'o1', orgName: 'Alpha', displayName: 'M365' }),
      inc({ id: 'p', orgId: null, displayName: 'UniFi' }),
      inc({ id: 'a1', orgId: 'o1', orgName: 'Alpha', displayName: 'DNS' }),
    ];
    expect(sortForDigest(rows).map((r) => r.id)).toEqual(['p', 'a1', 'a2', 'b']);
  });
});

describe('planUserDigest', () => {
  const tz = 'UTC';
  const friday = new Date('2026-10-16T08:09:00Z');
  const monday = new Date('2026-10-19T08:09:00Z');
  const lastSentAt = new Date('2026-10-15T08:10:00Z');

  it('returns null when there is nothing to say', () => {
    expect(planUserDigest({ open: [], resolved: [], toldIncidentIds: new Set(), lastSentAt: null, now: friday, timeZone: tz })).toBeNull();
  });

  it('includes a young open incident every day', () => {
    const plan = planUserDigest({ open: [inc()], resolved: [], toldIncidentIds: new Set(['i1']), lastSentAt, now: friday, timeZone: tz });
    expect(plan?.open.map((i) => i.id)).toEqual(['i1']);
  });

  it('a user whose only open incidents are past day 7 gets nothing on a weekday', () => {
    const old = inc({ openedAt: new Date('2026-10-01T00:00:00Z') });
    expect(planUserDigest({ open: [old], resolved: [], toldIncidentIds: new Set(), lastSentAt, now: friday, timeZone: tz })).toBeNull();
  });

  it('…and gets them on Monday', () => {
    const old = inc({ openedAt: new Date('2026-10-01T00:00:00Z') });
    expect(planUserDigest({ open: [old], resolved: [], toldIncidentIds: new Set(), lastSentAt, now: monday, timeZone: tz })?.open).toHaveLength(1);
  });

  it('lists a recovered incident the user was told about that resolved after the last sent digest', () => {
    const r = inc({ id: 'r1', resolvedAt: new Date('2026-10-15T20:00:00Z'), resolution: 'recovered' });
    const plan = planUserDigest({ open: [], resolved: [r], toldIncidentIds: new Set(['r1']), lastSentAt, now: friday, timeZone: tz });
    expect(plan?.restored.map((i) => i.id)).toEqual(['r1']);
    expect(plan?.open).toEqual([]);
  });

  it('does not list a recovery the user was never told about', () => {
    const r = inc({ id: 'r1', resolvedAt: new Date('2026-10-15T20:00:00Z'), resolution: 'recovered' });
    expect(planUserDigest({ open: [], resolved: [r], toldIncidentIds: new Set(), lastSentAt, now: friday, timeZone: tz })).toBeNull();
  });

  it('does not repeat a recovery already covered by the last sent digest', () => {
    const r = inc({ id: 'r1', resolvedAt: new Date('2026-10-15T07:00:00Z'), resolution: 'recovered' });
    expect(planUserDigest({ open: [], resolved: [r], toldIncidentIds: new Set(['r1']), lastSentAt, now: friday, timeZone: tz })).toBeNull();
  });

  it('never lists a retired incident as restored', () => {
    const r = inc({ id: 'r1', resolvedAt: new Date('2026-10-15T20:00:00Z'), resolution: 'retired' });
    expect(planUserDigest({ open: [], resolved: [r], toldIncidentIds: new Set(['r1']), lastSentAt, now: friday, timeZone: tz })).toBeNull();
  });

  it('a user with no sent digest gets no restored section', () => {
    const r = inc({ id: 'r1', resolvedAt: new Date('2026-10-15T20:00:00Z'), resolution: 'recovered' });
    expect(planUserDigest({ open: [], resolved: [r], toldIncidentIds: new Set(['r1']), lastSentAt: null, now: friday, timeZone: tz })).toBeNull();
  });

  it('sorts both sections for display', () => {
    const plan = planUserDigest({
      open: [inc({ id: 'o', orgId: 'x', orgName: 'Acme' }), inc({ id: 'p', orgId: null })],
      resolved: [],
      toldIncidentIds: new Set(),
      lastSentAt: null,
      now: friday,
      timeZone: tz,
    });
    expect(plan?.open.map((i) => i.id)).toEqual(['p', 'o']);
  });
});
