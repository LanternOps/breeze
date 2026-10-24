import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
  systemOpens: 0,
  timeZone: 'UTC',
}));

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
  resolveOrgTimezone: vi.fn(async () => ctx.timeZone),
  resolvePartnerTimezone: vi.fn(async () => ctx.timeZone),
}));

import type { QuoteWinRateSummary } from '@breeze/shared';
import { db } from '../../db';
import { reportTypeDef } from '../reportRegistry';
import type { ReportGenerationAuthority } from '../siteScope';
import { SITE_RESTRICTED_NOTE } from './common';
import {
  DECIDED_DENOMINATOR_NOTE,
  MATURITY_NOTE,
  NO_CONVERSION_TRACKING_NOTE,
  PRE_TAX_VALUES_NOTE,
  anomalyNote,
  depthCappedNote,
  generateQuoteWinRateReport,
  unreachableNote,
} from './quoteWinRateReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';

const dialect = new PgDialect();
type Call = { name: string; sql: string; params: unknown[] };
const calls: Call[] = [];
type Names = 'org_name' | 'diagnostics' | 'overall' | 'grouped' | 'grouped_money' | 'by_currency' | 'detail' | 'detail_count';

function respond(rows: Partial<Record<Names, unknown[]>> = {}) {
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    const name = /\/\* (?:qwr|qwrg):(\w+) \*\//.exec(compiled.sql)?.[1] ?? 'unknown';
    calls.push({ name, sql: compiled.sql, params: compiled.params });
    return (rows as Record<string, unknown[] | undefined>)[name] ?? [];
  }) as never);
}
const call = (name: string) => {
  const found = calls.find((c) => c.name === name);
  if (!found) throw new Error(`statement ${name} was not run; ran ${calls.map((c) => c.name).join(', ')}`);
  return found;
};

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) => ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };
const AUGUST = { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } };

const counts = (over: Record<string, unknown> = {}) => ({
  lineages: 10, won: 4, lost: 2, expired: 1, open: 3, anomalies: 0, viewed: 8,
  median_days_to_win: 4.26, median_days_to_loss: 2.0, ...over,
});
const moneyRow = (over: Record<string, unknown> = {}) => ({
  group_key: null, currency_code: 'USD',
  quoted_one_time: '1000.00', won_one_time: '400.00', decided_one_time: '700.00',
  quoted_mrv: '200.000000000000', won_mrv: '100.000000000000', decided_mrv: '150.000000000000', ...over,
});
const summaryOf = (r: { summary?: unknown }) => r.summary as QuoteWinRateSummary;

describe('generateQuoteWinRateReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.systemOpens = 0;
    ctx.timeZone = 'UTC';
  });

  it('is registered msp_staff, partner capable, with the shared detail cap', () => {
    const def = reportTypeDef('quote_win_rate');
    expect(def.audience).toBe('msp_staff');
    expect(def.supportedScopes).toEqual(['organization', 'partner']);
    expect(def.detailRowCap).toBe(5000);
  });

  it('win rate is decided-only with the open count beside it', async () => {
    respond({ overall: [counts()] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    // 4 won / (4 + 2 + 1) decided; the 3 open lineages stay out of the denominator.
    expect(s.overall.winRate).toBeCloseTo(4 / 7, 10);
    expect(s.overall.open).toBe(3);
    expect(s.overall.closeRate).toBeCloseTo(4 / 10, 10);
    expect(s.overall.viewedRate).toBeCloseTo(8 / 10, 10);
    expect(s.notes).toContain(DECIDED_DENOMINATOR_NOTE);
  });

  it('zero decided lineages → winRate null, never 0 (and no NaN anywhere)', async () => {
    respond({ overall: [counts({ lineages: 2, won: 0, lost: 0, expired: 0, open: 2, viewed: 0, median_days_to_win: null, median_days_to_loss: null })] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall.winRate).toBeNull();
    expect(s.overall.closeRate).toBe(0);
    expect(s.overall.medianDaysToWin).toBeNull();
    expect(s.overall.medianDaysToLoss).toBeNull();
    expect(JSON.stringify(s)).not.toContain('NaN');
  });

  it('an empty cohort reports null rates, not zeros', async () => {
    respond({ overall: [counts({ lineages: 0, won: 0, lost: 0, expired: 0, open: 0, viewed: 0, median_days_to_win: null, median_days_to_loss: null })] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall).toMatchObject({ winRate: null, closeRate: null, viewedRate: null });
  });

  it('medians are rounded to 1 dp', async () => {
    respond({ overall: [counts({ median_days_to_win: 4.26, median_days_to_loss: 2.04 })] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall.medianDaysToWin).toBe(4.3);
    expect(s.overall.medianDaysToLoss).toBe(2);
  });

  it('value win rate is per currency: USD and EUR are never summed', async () => {
    respond({
      overall: [counts()],
      by_currency: [
        moneyRow({ currency_code: 'EUR', quoted_one_time: '50.00', won_one_time: '0.00', decided_one_time: '50.00', quoted_mrv: '0', won_mrv: '0', decided_mrv: '0' }),
        moneyRow(),
      ],
    });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall.money.map((m) => m.currencyCode)).toEqual(['EUR', 'USD']);
    const [eur, usd] = s.overall.money;
    expect(eur).toMatchObject({ currencyCode: 'EUR', quotedOneTime: '50.00', wonOneTime: '0.00', valueWinRate: 0 });
    // USD: (400 + 100) / (700 + 150)
    expect(usd!.valueWinRate).toBeCloseTo(500 / 850, 10);
    expect(Object.keys(s.overall)).not.toContain('quotedOneTime');
  });

  it('a currency with nothing decided has a null value win rate, not 0', async () => {
    respond({
      overall: [counts()],
      by_currency: [moneyRow({ won_one_time: '0', decided_one_time: '0', won_mrv: '0', decided_mrv: '0' })],
    });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall.money[0]!.valueWinRate).toBeNull();
  });

  it('monthly recurring value = monthly + annual/12, summed exactly in SQL and rounded ONCE here', async () => {
    respond({
      overall: [counts()],
      by_currency: [moneyRow({ quoted_mrv: '40.005000000000', won_mrv: '10.004999999999', decided_mrv: '40.005' })],
    });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall.money[0]).toMatchObject({ quotedMonthlyRecurring: '40.01', wonMonthlyRecurring: '10.00' });
    const sql = call('by_currency').sql;
    expect(sql).toContain('::text');
    expect(sql).not.toMatch(/ROUND\(/i);
  });

  it('maturity note only when open > 0', async () => {
    respond({ overall: [counts({ open: 3 })] });
    expect(summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority)).notes).toContain(MATURITY_NOTE);
    calls.length = 0;
    respond({ overall: [counts({ open: 0 })] });
    expect(summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority)).notes).not.toContain(MATURITY_NOTE);
  });

  it('always prints the pre-tax values note and the no-conversion-tracking note (OD8-A)', async () => {
    respond({ overall: [counts()] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.notes).toContain(PRE_TAX_VALUES_NOTE);
    expect(s.notes).toContain(NO_CONVERSION_TRACKING_NOTE);
    expect(NO_CONVERSION_TRACKING_NOTE).toMatch(/pending activation/);
  });

  it('anomalies are noted and counted but never part of a rate', async () => {
    respond({ overall: [counts({ lineages: 5, won: 1, lost: 1, expired: 0, open: 2, anomalies: 1, viewed: 3 })] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.overall.anomalies).toBe(1);
    expect(s.overall.winRate).toBe(0.5);
    expect(s.notes).toContain(anomalyNote(1));
  });

  it('unreachable and depth-capped lineages become notes with counts, never rates', async () => {
    respond({ diagnostics: [{ unreachable: 2, depth_capped: 1 }], overall: [counts()] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.diagnostics).toEqual({ unreachable: 2, depthCapped: 1 });
    expect(s.notes).toContain(unreachableNote(2));
    expect(s.notes).toContain(depthCappedNote(1));
    // They do not appear in any count.
    expect(s.overall.lineages).toBe(10);
  });

  it('no diagnostics note when there is nothing to report', async () => {
    respond({ diagnostics: [{ unreachable: 0, depth_capped: 0 }], overall: [counts()] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.notes.join(' ')).not.toMatch(/could not be reached|revision chain/i);
  });

  it('groupBy defaults by scope (organization at partner scope, author at org scope) and an explicit value wins', async () => {
    respond();
    expect(summaryOf(await generateQuoteWinRateReport(partnerScope(), AUGUST, partnerAuthority)).groupBy).toBe('organization');
    expect(call('grouped').sql).toContain('l.org_id::text AS group_key');
    calls.length = 0;
    respond();
    expect(summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority)).groupBy).toBe('author');
    expect(call('grouped').sql).toContain('l.author_key AS group_key');
    calls.length = 0;
    respond();
    expect(summaryOf(await generateQuoteWinRateReport(orgScope, { ...AUGUST, groupBy: 'currency' }, orgAuthority)).groupBy).toBe('currency');
    expect(call('grouped').sql).toContain('l.currency_code AS group_key');
  });

  it('author grouping reads the ROOT quote\'s created_by', async () => {
    respond();
    await generateQuoteWinRateReport(orgScope, { ...AUGUST, groupBy: 'author' }, orgAuthority);
    expect(call('grouped').sql).toContain('r.created_by');
  });

  it('groups carry counts, rates and per-currency money', async () => {
    respond({
      overall: [counts()],
      grouped: [{ group_key: ORG_A, group_label: 'Acme', ...counts({ lineages: 4, won: 2, lost: 1, expired: 0, open: 1, viewed: 3 }) }],
      grouped_money: [moneyRow({ group_key: ORG_A })],
    });
    const s = summaryOf(await generateQuoteWinRateReport(partnerScope(), AUGUST, partnerAuthority));
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ groupKey: ORG_A, groupLabel: 'Acme', lineages: 4, won: 2, open: 1 });
    expect(s.groups[0]!.winRate).toBeCloseTo(2 / 3, 10);
    expect(s.groups[0]!.money).toHaveLength(1);
    expect(s.groups[0]!.money[0]).toMatchObject({ currencyCode: 'USD', wonOneTime: '400.00' });
  });

  it('partner scope binds the partner id AND the org allowlist in the lineage statements', async () => {
    respond();
    await generateQuoteWinRateReport(partnerScope(), AUGUST, partnerAuthority);
    for (const name of ['diagnostics', 'overall', 'grouped', 'grouped_money', 'by_currency', 'detail']) {
      const c = call(name);
      expect(c.sql, name).toMatch(/q\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)/);
      expect(c.sql, name).toContain('q.partner_id = ');
      expect(c.sql, name).toContain('c.org_id = w.org_id');
      expect(c.params, name).toEqual(expect.arrayContaining([PARTNER, ORG_A, ORG_B, 50]));
    }
  });

  it('org scope binds the single org and no partner id', async () => {
    respond({ org_name: [{ name: 'Acme' }] });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    for (const name of ['diagnostics', 'overall', 'grouped', 'by_currency', 'detail']) {
      const c = call(name);
      expect(c.sql, name).not.toContain('q.partner_id');
      expect(c.params, name).toContain(ORG_A);
      expect(c.params, name).not.toContain(PARTNER);
    }
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
  });

  it('binds the cohort window in the owner timezone and the UTC as-of date for expiry', async () => {
    ctx.timeZone = 'America/Chicago';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T23:30:00Z'));
    try {
      respond();
      const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
      expect(call('overall').params).toEqual(expect.arrayContaining(['2026-08-01T05:00:00.000Z', '2026-09-01T05:00:00.000Z', '2026-09-15']));
      expect(s.period).toMatchObject({ timeZone: 'America/Chicago', start: '2026-08-01T05:00:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('detail rows map the lineage grain; declineReason is detail-only', async () => {
    respond({
      overall: [counts()],
      detail: [{
        root_quote_id: 'r1', terminal_quote_id: 't1', quote_number: 'Q-1-R2', org_id: ORG_A, org_name: 'Acme',
        author_name: 'Dana Tech', versions: 2, first_sent_at: '2026-08-02T10:00:00.000Z', outcome: 'lost',
        outcome_at: '2026-08-05T10:00:00.000Z', currency_code: 'USD', one_time_total: '450.00',
        monthly_recurring_value: '40.000000000000', decline_reason: 'Too expensive',
      }],
    });
    const s = summaryOf(await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority));
    expect(s.rows).toEqual([{
      rootQuoteId: 'r1', terminalQuoteId: 't1', quoteNumber: 'Q-1-R2', orgId: ORG_A, orgName: 'Acme',
      authorName: 'Dana Tech', versions: 2, firstSentAt: '2026-08-02T10:00:00.000Z', outcome: 'lost',
      outcomeAt: '2026-08-05T10:00:00.000Z', currencyCode: 'USD', oneTimeTotal: '450.00',
      monthlyRecurringValue: '40.00', declineReason: 'Too expensive',
    }]);
    expect(JSON.stringify(s.groups)).not.toContain('Too expensive');
  });

  it('detail cap truncates rows, not totals', async () => {
    const detail = Array.from({ length: 5001 }, (_, i) => ({
      root_quote_id: `r${i}`, terminal_quote_id: `t${i}`, quote_number: `Q-${i}`, org_id: ORG_A, org_name: 'Acme',
      author_name: 'Dana Tech', versions: 1, first_sent_at: '2026-08-02T10:00:00.000Z', outcome: 'won',
      outcome_at: '2026-08-03T10:00:00.000Z', currency_code: 'USD', one_time_total: '1.00',
      monthly_recurring_value: '0', decline_reason: null,
    }));
    respond({ detail, detail_count: [{ n: 6000 }], overall: [counts({ lineages: 6000, won: 6000, lost: 0, expired: 0, open: 0, viewed: 6000 })] });
    const result = await generateQuoteWinRateReport(orgScope, AUGUST, orgAuthority);
    const s = summaryOf(result);
    expect(call('detail').params).toContain(5001);
    expect(call('overall').sql).not.toContain('LIMIT');
    expect(result.rows).toHaveLength(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 6000, truncated: true });
    expect(s.overall.lineages).toBe(6000);
  });

  it('a site-restricted authority queries NOTHING and prints the site note', async () => {
    respond();
    const restricted: ReportGenerationAuthority = {
      ...orgAuthority,
      scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['55555555-5555-4555-8555-555555555555'] },
    };
    const result = await generateQuoteWinRateReport(orgScope, AUGUST, restricted);
    expect(db.execute).not.toHaveBeenCalled();
    expect(summaryOf(result).notes).toContain(SITE_RESTRICTED_NOTE);
    expect(summaryOf(result).overall.winRate).toBeNull();
  });

  it('a partner with no active organizations short-circuits without a quote query', async () => {
    respond();
    const result = await generateQuoteWinRateReport(partnerScope([]), AUGUST, partnerAuthority);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
    expect(s.notes.join(' ')).toMatch(/no active or trial organizations/i);
    expect(s.overall.winRate).toBeNull();
  });

  it('discloses the partner org-list filter at partner scope', async () => {
    respond();
    const s = summaryOf(await generateQuoteWinRateReport(partnerScope(), AUGUST, partnerAuthority));
    expect(s.notes.join(' ')).toMatch(/suspended.*archived.*excluded/i);
  });

  it('rejects an unsupported config key before any query', async () => {
    respond();
    await expect(generateQuoteWinRateReport(orgScope, { groupBy: 'model' }, orgAuthority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
