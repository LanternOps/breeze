import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
  systemOpens: 0,
}));
const loadTicketCalendars = vi.hoisted(() => vi.fn(async () => new Map()));

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  getCurrentDbAccessContext: () => ctx.current,
  hasDbAccessContext: () => ctx.current !== undefined,
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
    ctx.systemOpens += 1;
    const previous = ctx.current;
    ctx.current = { scope: 'system' };
    try {
      return await fn();
    } finally {
      ctx.current = previous;
    }
  },
}));
vi.mock('../portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => 'UTC'),
  resolvePartnerTimezone: vi.fn(async () => 'UTC'),
}));
vi.mock('../ticketSlaDeadlines', () => ({ loadTicketCalendars }));

import type { TicketSlaPerformanceSummary } from '@breeze/shared';
import { db } from '../../db';
import { ReportScopeMismatchError } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { resolveOrgTimezone } from '../portal/timezone';
import { SITE_RESTRICTED_NOTE } from './common';
import { generateTicketSlaPerformanceReport } from './ticketSlaPerformanceReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OCTOBER = { kind: 'custom' as const, start: '2026-10-01', end: '2026-10-31' };

const dialect = new PgDialect();
type Call = { sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];

/** Routes by statement text, so a reordering in the generator cannot pass by luck. */
function stubDb(opts: { opened?: unknown[]; decided?: unknown[]; orgName?: string | null } = {}) {
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    calls.push({ sql: compiled.sql, params: compiled.params, contextScope: ctx.current?.scope });
    if (compiled.sql.includes('UNION ALL')) return opts.decided ?? [];
    if (compiled.sql.includes('GROUP BY t.priority')) return opts.opened ?? [];
    return [{ name: opts.orgName === undefined ? 'Acme' : opts.orgName }];
  }) as never);
}

const orgScope = { kind: 'organization' as const, orgId: ORG_A };
const authority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-11-01T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const restricted: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
  capturedAt: new Date('2026-11-01T00:00:00Z'), fingerprint: 'b'.repeat(64),
};

function decidedRow(i: number, over: Record<string, unknown> = {}) {
  return {
    ticket_id: `t${i}`, ticket_number: `T-${i}`, subject: null, priority: 'high', target: 'response',
    target_minutes: 60, created_at: '2026-10-05T09:00:00.000Z', due_at: '2026-10-05T10:00:00.000Z',
    completed_at: '2026-10-05T10:30:00.000Z', met: false, calendar_revision_id: null,
    ...over,
  };
}

const summaryOf = (r: { summary?: unknown }) => r.summary as TicketSlaPerformanceSummary;
const decidedCall = () => calls.find((c) => c.sql.includes('UNION ALL'))!;
const openedCall = () => calls.find((c) => c.sql.includes('GROUP BY t.priority'))!;

describe('generateTicketSlaPerformanceReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.systemOpens = 0;
    loadTicketCalendars.mockImplementation(async () => new Map());
  });
  afterEach(() => vi.useRealTimers());

  it('parses config before any query and rejects an unknown key type', async () => {
    stubDb();
    await expect(generateTicketSlaPerformanceReport(orgScope, { includeSubjects: 'yes' }, authority)).rejects.toThrow();
    await expect(generateTicketSlaPerformanceReport(orgScope, { orgIds: [ORG_B] }, authority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a site-restricted authority queries nothing', async () => {
    stubDb({ opened: [{ priority: 'high', opened: 9, without_target: 0 }], decided: [decidedRow(1)] });
    const result = await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, restricted);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(ctx.systemOpens).toBe(0);
    // No rows: a CSV of zeros would read as "no tickets", and nothing was measured.
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
    expect(s.overall.responseAttainment).toBeNull();
    expect(s.org).toEqual({ orgId: ORG_A, orgName: null });
  });

  it('runs every statement inside ONE system context when there is no ambient context', async () => {
    stubDb();
    await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority);
    expect(ctx.systemOpens).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['system']));
  });

  it('runs in an ambient org context that can see the org, opening no second context', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_A] };
    stubDb();
    await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority);
    expect(ctx.systemOpens).toBe(0);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['organization']));
  });

  it('refuses an ambient org context that cannot see the org', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_B] };
    stubDb();
    await expect(generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('refuses a partner scope: this type is org-only', async () => {
    stubDb();
    await expect(generateTicketSlaPerformanceReport(
      { kind: 'partner', partnerId: USER, orgIds: [ORG_A] }, {}, authority,
    )).rejects.toThrow(/organization scope/);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('binds the org to every ticket statement', async () => {
    stubDb();
    await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority);
    for (const call of calls) expect(call.params).toContain(ORG_A);
  });

  it('defaults to last_full_month and no subjects', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T12:00:00Z'), toFake: ['Date'] });
    stubDb();
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, {}, authority));
    expect(s.period.kind).toBe('last_full_month');
    expect(s.period.start).toBe('2026-10-01T00:00:00.000Z');
    expect(s.period.end).toBe('2026-11-01T00:00:00.000Z');
    expect(s.includeSubjects).toBe(false);
    expect(decidedCall().sql).not.toContain('t.subject');
  });

  it('includeSubjects selects the subject and carries it to the breach row', async () => {
    stubDb({ decided: [decidedRow(1, { subject: 'Printer down' })] });
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER, includeSubjects: true }, authority));
    expect(decidedCall().sql).toContain('t.subject AS subject');
    expect(s.includeSubjects).toBe(true);
    expect(s.breaches.rows[0]!.subject).toBe('Printer down');
  });

  it('clips the decided window at generatedAt for the current month', async () => {
    const now = new Date('2026-11-15T12:00:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    stubDb();
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: { kind: 'custom', start: '2026-11-01', end: '2026-11-30' } }, authority));
    expect(s.period.end).toBe('2026-12-01T00:00:00.000Z');
    expect(s.period.measuredThrough).toBe(now.toISOString());
    expect(decidedCall().params).toContain(now.toISOString());
    expect(decidedCall().params).not.toContain('2026-12-01T00:00:00.000Z');
    // Volume is not clipped: it counts creation in the period as resolved.
    expect(openedCall().params).toContain('2026-12-01T00:00:00.000Z');
  });

  it('a finished period is measured through its own end, not through generation', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T12:00:00Z'), toFake: ['Date'] });
    stubDb();
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(s.period.measuredThrough).toBe('2026-11-01T00:00:00.000Z');
    expect(decidedCall().params).toContain('2026-11-01T00:00:00.000Z');
  });

  it('caps breaches at 1000 with the full available count and truncated=true', async () => {
    const decided = Array.from({ length: 1005 }, (_, i) => decidedRow(i));
    stubDb({ decided });
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(s.breaches.rows).toHaveLength(1000);
    expect(s.breaches).toMatchObject({ cap: 1000, stored: 1000, available: 1005, truncated: true });
    // The aggregates are over the full set.
    expect(s.overall.responseMissed).toBe(1005);
    expect(s.breaches.rows[0]!.ticketId).toBe('t0');
  });

  it('under the cap nothing is truncated', async () => {
    stubDb({ decided: [decidedRow(1), decidedRow(2, { met: true, completed_at: '2026-10-05T09:30:00.000Z' })] });
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(s.breaches).toMatchObject({ cap: 1000, stored: 1, available: 1, truncated: false });
    expect(s.overall.responseMeasured).toBe(2);
  });

  it('prints the seven notes in order and the calendar note only when needed', async () => {
    stubDb();
    const clean = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(clean.notes).toEqual([
      'Response and resolution are counted in the period their outcome was decided: when the ticket was answered or resolved on time, or when its deadline passed. Consecutive reports therefore count each outcome once.',
      '"Tickets opened" counts tickets created in the period; it is a volume figure and is not the denominator of any percentage.',
      "Times are measured on each ticket's SLA clock — its business hours, excluding time the SLA was paused — the same clock its target uses.",
      'The SLA target shown for a priority is the most common target agreed on its tickets; "varies" means tickets in that priority carried different targets.',
      'Tickets with no SLA target are counted but not timed or included in percentages.',
      'Planned work and tickets merged into another ticket are excluded.',
      'A report reflects ticket state when it was generated; a ticket reopened later is measured again in a later report.',
    ]);

    stubDb({ decided: [decidedRow(1, { calendar_revision_id: 'rev-gone' })] });
    const withGap = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(withGap.notes).toHaveLength(8);
    expect(withGap.notes[7]).toBe(
      '1 outcome(s) are included in the percentages but not in the times because their business-hours calendar could not be read.',
    );
  });

  it('notes disclose that a report reflects ticket state at generation time', async () => {
    stubDb();
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(s.notes.join(' ')).toMatch(/ticket state when it was generated/);
    expect(s.notes.join(' ')).toMatch(/reopened later is measured again/);
  });

  it('a target whose calendar revision cannot be loaded counts for attainment but not durations', async () => {
    stubDb({ decided: [decidedRow(1, { calendar_revision_id: 'rev-gone' })] });
    const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
    expect(loadTicketCalendars).toHaveBeenCalledWith(db, ['rev-gone']);
    expect(s.overall.responseMeasured).toBe(1);
    expect(s.overall.responseTimedSample).toBe(0);
    expect(s.unmeasuredDurations).toBe(1);
  });

  it('rows === summary.priorities', async () => {
    stubDb({
      opened: [{ priority: 'urgent', opened: 2, without_target: 1 }],
      decided: [decidedRow(1)],
    });
    const result = await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority);
    const s = summaryOf(result);
    expect(result.rows).toBe(s.priorities);
    expect(s.rows).toBe(s.priorities);
    expect(result.rowCount).toBe(4);
    expect(s.priorities.map((r) => r.priority)).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(s.priorities[0]).toMatchObject({ ticketsOpened: 2, ticketsWithoutTarget: 1 });
    expect(s.priorities[1]).toMatchObject({ responseMissed: 1, responseMedianMinutes: 90 });
  });

  describe('evidence runs (#11018 W2)', () => {
    // Monthly occurrence: inclusive period end, generated on the due day.
    const evidence = (generatedAt: string) => ({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      generatedAt,
      deliverableId: '44444444-4444-4444-8444-444444444444',
    });

    it('an evidence run uses the occurrence period, not config.period', async () => {
      stubDb();
      const result = await generateTicketSlaPerformanceReport(
        orgScope, { period: { kind: 'custom', start: '2026-01-01', end: '2026-01-31' } }, authority,
        evidence('2026-11-02T12:00:00.000Z'),
      );
      const s = summaryOf(result);
      expect(s.period.kind).toBe('custom');
      expect(s.period.start).toBe('2026-10-01T00:00:00.000Z');
      expect(s.period.end).toBe('2026-11-01T00:00:00.000Z');
      expect(s.period.label).toBe('2026-10-01 to 2026-10-31');
      expect(JSON.stringify(decidedCall().params)).toContain('2026-11-01T00:00:00.000Z');
      expect(JSON.stringify(decidedCall().params)).not.toContain('2026-01-01');
      expect(JSON.stringify(openedCall().params)).toContain('2026-10-01T00:00:00.000Z');
    });

    it('an evidence run takes its generation time from the context, not from now', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-03-15T12:00:00Z'));
      stubDb();
      const s = summaryOf(await generateTicketSlaPerformanceReport(
        orgScope, {}, authority, evidence('2026-11-02T12:00:00.000Z'),
      ));
      expect(s.period.start).toBe('2026-10-01T00:00:00.000Z');
      expect(s.generatedAt).toBe('2026-11-02T12:00:00.000Z');
    });

    it('an evidence run clips the window at generatedAt and says so', async () => {
      stubDb();
      const generatedAt = '2026-10-31T05:18:00.000Z';
      const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, {}, authority, evidence(generatedAt)));
      expect(s.generatedAt).toBe(generatedAt);
      // The period keeps its whole last day; only the measurement stops early.
      expect(s.period.end).toBe('2026-11-01T00:00:00.000Z');
      expect(s.period.measuredThrough).toBe(generatedAt);
      expect(JSON.stringify(decidedCall().params)).toContain(generatedAt);
      expect(JSON.stringify(decidedCall().params)).not.toContain('2026-11-01T00:00:00.000Z');
      expect(s.notes).toContain(
        'This service report was generated on 2026-10-31 and covers outcomes decided through that time.',
      );
    });

    it('a late evidence run is measured through the period end and does not claim otherwise', async () => {
      stubDb();
      const s = summaryOf(await generateTicketSlaPerformanceReport(
        orgScope, {}, authority, evidence('2026-11-20T09:00:00.000Z'),
      ));
      expect(s.period.measuredThrough).toBe('2026-11-01T00:00:00.000Z');
      expect(s.notes.join(' ')).not.toMatch(/service report was generated on/);
    });

    it('prints the generation date in the owner timezone, not UTC', async () => {
      vi.mocked(resolveOrgTimezone).mockResolvedValueOnce('America/Denver');
      stubDb();
      // 03:00Z on Oct 31 is still Oct 30 in Denver.
      const s = summaryOf(await generateTicketSlaPerformanceReport(
        orgScope, {}, authority, evidence('2026-10-31T03:00:00.000Z'),
      ));
      expect(s.notes).toContain(
        'This service report was generated on 2026-10-30 and covers outcomes decided through that time.',
      );
    });

    it('a staff run prints no evidence note', async () => {
      stubDb();
      const s = summaryOf(await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority));
      expect(s.notes.join(' ')).not.toMatch(/service report was generated on/);
    });

    it('a site-restricted authority still queries nothing on an evidence run', async () => {
      stubDb();
      await generateTicketSlaPerformanceReport(orgScope, {}, restricted, evidence('2026-10-31T05:18:00.000Z'));
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  it('fills the period, the org name and the generation stamp', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T12:00:00.000Z'), toFake: ['Date'] });
    stubDb({ orgName: 'Acme' });
    const result = await generateTicketSlaPerformanceReport(orgScope, { period: OCTOBER }, authority);
    const s = summaryOf(result);
    expect(s.org).toEqual({ orgId: ORG_A, orgName: 'Acme' });
    expect(s.generatedAt).toBe('2026-11-15T12:00:00.000Z');
    expect(result.generatedAt).toBe('2026-11-15T12:00:00.000Z');
    expect(s.period).toEqual({
      kind: 'custom', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
      label: '2026-10-01 to 2026-10-31', timeZone: 'UTC', measuredThrough: '2026-11-01T00:00:00.000Z',
    });
  });
});
