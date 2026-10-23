import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #9828 W3 Task 3.2 — the client_profitability generator. Same harness as the
 * other business generators: `runInReportScope` is REAL, the DB mock records
 * which context each statement ran in, and every statement is compiled with
 * the real Postgres dialect.
 *
 * Statement order: org names, invoice-line fold, hours, then (org scope only)
 * the invoice detail.
 */
const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
}));

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  getCurrentDbAccessContext: () => ctx.current,
  hasDbAccessContext: () => ctx.current !== undefined,
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
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

import type { ClientProfitabilitySummary } from '@breeze/shared';
import { db } from '../../db';
import { clientProfitabilityConfigSchema } from '../reportConfigSchemas';
import type { ReportGenerationAuthority } from '../siteScope';
import {
  generateClientProfitabilityReport,
  LABOR_ESTIMATE_LABEL,
  LABOR_RATE_CURRENCY_NOTE,
  MULTI_CURRENCY_HOURS_NOTE,
  NO_HOURS_NOTE,
  PARTNER_RATE_SCOPE_NOTE,
  partialBundleNote,
} from './clientProfitabilityReport';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, SITE_RESTRICTED_NOTE } from './common';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const AUGUST = { kind: 'custom' as const, start: '2026-08-01', end: '2026-08-31' };

const dialect = new PgDialect();
type Call = { sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];

function queueExecute(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    calls.push({ sql: compiled.sql, params: compiled.params, contextScope: ctx.current?.scope });
    return queue.shift() ?? [];
  }) as never);
}

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) => ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };

const NAMES = [{ id: ORG_A, name: 'Acme' }, { id: ORG_B, name: 'Globex' }];

type Money = { revenue: string; cbr?: string; cost?: string; missing?: number; partial?: number };
function fold(org: string, currency: string, category: string, m: Money) {
  const cbr = m.cbr ?? '0.00';
  return {
    org_id: org, currency_code: currency, category,
    revenue: m.revenue, cost_bearing_revenue: cbr, cost: m.cost ?? '0.00',
    unknown_cost_revenue: (Number(m.revenue) - Number(cbr)).toFixed(2),
    lines_missing_cost: m.missing ?? 0, partial_cost_bundles: m.partial ?? 0, invoice_count: 1,
  };
}
function hours(org: string | null, currency: string | null, billable = 0, included = 0, nonBillable = 0) {
  return { org_id: org, currency_code: currency, billable_minutes: billable, included_minutes: included, non_billable_minutes: nonBillable };
}

/** The plan's worked fixture: recurring 1000.00 NULL-cost + product 500.00 at cost 300.00; 10 h. */
const WORKED_FOLD = [
  fold(ORG_A, 'USD', 'product', { revenue: '500.00', cbr: '500.00', cost: '300.00' }),
  fold(ORG_A, 'USD', 'recurring', { revenue: '1000.00', missing: 1 }),
];
const WORKED_HOURS = [hours(ORG_A, 'USD', 300, 240, 60)];

const summaryOf = (r: { summary?: unknown }) => r.summary as ClientProfitabilitySummary;
const run = (config: Record<string, unknown>, scope: ReturnType<typeof partnerScope> | typeof orgScope = partnerScope([ORG_A])) =>
  generateClientProfitabilityReport(scope, { period: AUGUST, ...config }, scope.kind === 'partner' ? partnerAuthority : orgAuthority)
    .then(summaryOf);

describe('generateClientProfitabilityReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
  });

  it('all-labor client: marginPct null, coverage 0, unknown = revenue (T2)', async () => {
    queueExecute(NAMES, [fold(ORG_A, 'USD', 'labor', { revenue: '166.25', missing: 2 })], [hours(ORG_A, 'USD', 105)]);
    const s = await run({});
    const [money] = s.orgs[0]!.money;
    expect(money).toMatchObject({
      currencyCode: 'USD', revenue: '166.25', costBearingRevenue: '0.00', cost: '0.00', grossMargin: '0.00',
      marginPct: null, costCoveragePct: 0, unknownCostRevenue: '166.25', linesMissingCost: 2,
    });
    expect(s.byCurrency[0]).toMatchObject({ revenue: '166.25', marginPct: null, costCoveragePct: 0 });
  });

  it('rate unset → no labor fields, no estimate note (OD2-A parity)', async () => {
    queueExecute(NAMES, WORKED_FOLD, WORKED_HOURS);
    const s = await run({});
    expect(s.laborCostPerHour).toBeNull();
    const [money] = s.orgs[0]!.money;
    expect(money).toMatchObject({ estimatedLaborCost: null, estimatedContributionAfterLabor: null, grossMargin: '200.00' });
    expect(s.notes.join(' ')).not.toContain(LABOR_ESTIMATE_LABEL);
    expect(s.rows.every((r) => r.estimatedContributionAfterLabor === null)).toBe(true);
  });

  it('rate set, single currency → estimated labor cost and contribution per formula (worked fixture: 750.00)', async () => {
    queueExecute(NAMES, WORKED_FOLD, WORKED_HOURS);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } });
    expect(s.laborCostPerHour).toEqual({ amount: '45.00', currencyCode: 'USD' });
    const org = s.orgs[0]!;
    expect(org.hoursAttribution).toBe('single_currency');
    expect(org.hours).toEqual({ total: 10, billable: 5, included: 4, nonBillable: 1 });
    expect(org.money[0]).toMatchObject({
      revenue: '1500.00', costBearingRevenue: '500.00', cost: '300.00', grossMargin: '200.00',
      marginPct: 0.4, costCoveragePct: 500 / 1500,
      estimatedLaborCost: '450.00',
      estimatedContributionAfterLabor: '750.00', // 200.00 + 1000.00 − 450.00
      nullCostRecurringRevenue: '1000.00',
      excludedUnknownCostRevenue: '0.00',
    });
    expect(s.byCurrency[0]).toMatchObject({ estimatedLaborCost: '450.00', estimatedContributionAfterLabor: '750.00' });
    expect(s.notes.some((n) => n.startsWith(LABOR_ESTIMATE_LABEL))).toBe(true);
    expect(s.rows[0]).toMatchObject({ orgId: ORG_A, currencyCode: 'USD', hoursTotal: 10, estimatedContributionAfterLabor: '750.00' });
  });

  it('contribution prints its NULL-cost recurring share and leaves NULL-cost product/AI/other out', async () => {
    queueExecute(NAMES, [
      ...WORKED_FOLD,
      fold(ORG_A, 'USD', 'labor', { revenue: '200.00', missing: 1 }),
      fold(ORG_A, 'USD', 'ai', { revenue: '30.00', missing: 1 }),
      fold(ORG_A, 'USD', 'other', { revenue: '20.00', missing: 1 }),
    ], WORKED_HOURS);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } });
    expect(s.orgs[0]!.money[0]).toMatchObject({
      nullCostRecurringRevenue: '1000.00',
      excludedUnknownCostRevenue: '50.00',
      estimatedContributionAfterLabor: '950.00', // 200 + (1000 + 200) − 450; the 50.00 AI/other stays out
    });
  });

  it('rate in another currency → estimate null + note', async () => {
    queueExecute(NAMES, WORKED_FOLD, WORKED_HOURS);
    const s = await run({ laborCostPerHour: { amount: '40.00', currencyCode: 'EUR' } });
    expect(s.orgs[0]!.money[0]).toMatchObject({ estimatedLaborCost: null, estimatedContributionAfterLabor: null });
    expect(s.orgs[0]!.money[0]!.effectiveServiceRate).toBe(100); // the rate figures still print
    expect(s.notes).toContain(LABOR_RATE_CURRENCY_NOTE('EUR'));
  });

  it('multi-currency org → hours printed once, rate figures null on every row, note (Review Focus 2)', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'EUR', 'recurring', { revenue: '400.00', missing: 1 }),
      fold(ORG_A, 'USD', 'recurring', { revenue: '1000.00', missing: 1 }),
    ], [hours(ORG_A, 'USD', 600)]);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } });
    const org = s.orgs[0]!;
    expect(org.hoursAttribution).toBe('multi_currency');
    expect(org.hours.total).toBe(10);
    expect(org.money.map((m) => m.currencyCode)).toEqual(['EUR', 'USD']);
    for (const m of org.money) {
      expect(m).toMatchObject({ effectiveServiceRate: null, revenuePerHour: null, estimatedLaborCost: null, estimatedContributionAfterLabor: null });
    }
    expect(s.notes).toContain(MULTI_CURRENCY_HOURS_NOTE);
    // Detail rows: hours never on a currency row; one hours-only row instead.
    const orgRows = s.rows.filter((r) => r.orgId === ORG_A);
    expect(orgRows.filter((r) => r.currencyCode !== null).every((r) => r.hoursTotal === null)).toBe(true);
    expect(orgRows.filter((r) => r.currencyCode === null)).toEqual([expect.objectContaining({ hoursTotal: 10, revenue: null })]);
  });

  it('single revenue currency but an entry stamped in another currency → not attributed', async () => {
    queueExecute(NAMES, WORKED_FOLD, [hours(ORG_A, 'USD', 540), hours(ORG_A, 'EUR', 60)]);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } });
    const org = s.orgs[0]!;
    expect(org.hoursAttribution).toBe('multi_currency');
    expect(org.hours.total).toBe(10);
    expect(org.money[0]).toMatchObject({ effectiveServiceRate: null, estimatedLaborCost: null, estimatedContributionAfterLabor: null });
    expect(s.notes).toContain(MULTI_CURRENCY_HOURS_NOTE);
  });

  it('zero hours → effective rate null and NO labor estimate (unlogged time is not zero labor), with a note', async () => {
    queueExecute(NAMES, WORKED_FOLD, []);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } });
    expect(s.orgs[0]!.hours.total).toBe(0);
    expect(s.orgs[0]!.money[0]).toMatchObject({
      effectiveServiceRate: null, revenuePerHour: null, estimatedLaborCost: null, estimatedContributionAfterLabor: null,
    });
    expect(s.byCurrency[0]).toMatchObject({ estimatedLaborCost: null, estimatedContributionAfterLabor: null });
    expect(s.notes).toContain(NO_HOURS_NOTE);
  });

  it('partner byCurrency: estimate figures sum the attributed clients when every client in the currency is attributed', async () => {
    queueExecute(NAMES, [
      ...WORKED_FOLD,
      fold(ORG_B, 'USD', 'product', { revenue: '100.00', cbr: '100.00', cost: '40.00' }),
      fold(ORG_B, 'USD', 'labor', { revenue: '300.00', missing: 2 }),
    ], [...WORKED_HOURS, hours(ORG_B, 'USD', 120)]);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } }, partnerScope());
    // Acme: 750.00 (worked fixture). Globex: 60 + 300 − 2 h × 45 = 270.00.
    expect(s.orgs.find((o) => o.orgId === ORG_B)!.money[0]!.estimatedContributionAfterLabor).toBe('270.00');
    expect(s.byCurrency[0]).toMatchObject({
      revenue: '1900.00', grossMargin: '260.00', estimatedLaborCost: '540.00', estimatedContributionAfterLabor: '1020.00',
      effectiveServiceRate: 108.33, // (1000 + 300) / 12 h
    });
    expect(s.notes).not.toContain(PARTNER_RATE_SCOPE_NOTE);
    expect(s.notes.some((n) => n === LABOR_RATE_CURRENCY_NOTE('USD'))).toBe(false);
  });

  it('partner byCurrency: one unattributed client in the currency blanks the partner-wide rate and estimate (same population as margin)', async () => {
    queueExecute(NAMES, [
      ...WORKED_FOLD,
      fold(ORG_B, 'USD', 'labor', { revenue: '300.00', missing: 2 }),
      fold(ORG_B, 'EUR', 'labor', { revenue: '80.00', missing: 1 }),
    ], [...WORKED_HOURS, hours(ORG_B, 'USD', 120)]);
    const s = await run({ laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } }, partnerScope());
    expect(s.orgs.find((o) => o.orgId === ORG_A)!.money[0]!.estimatedContributionAfterLabor).toBe('750.00');
    const usd = s.byCurrency.find((m) => m.currencyCode === 'USD')!;
    expect(usd).toMatchObject({
      revenue: '1800.00', estimatedLaborCost: null, estimatedContributionAfterLabor: null, effectiveServiceRate: null, revenuePerHour: null,
    });
    expect(s.notes).toContain(PARTNER_RATE_SCOPE_NOTE);
    expect(s.notes).toContain(LABOR_RATE_CURRENCY_NOTE('USD')); // EUR revenue exists, the rate is USD
  });

  it('JPY and USD clients are never summed together', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'USD', 'product', { revenue: '500.00', cbr: '500.00', cost: '300.00' }),
      fold(ORG_B, 'JPY', 'product', { revenue: '5000.00', cbr: '5000.00', cost: '3000.00' }),
    ], []);
    const s = await run({}, partnerScope());
    expect(s.byCurrency.map((m) => [m.currencyCode, m.revenue, m.cost])).toEqual([['JPY', '5000.00', '3000.00'], ['USD', '500.00', '300.00']]);
  });

  it('partial-cost bundles: counted across currencies and noted; no note without one', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'USD', 'product', { revenue: '400.00', missing: 1, partial: 1 }),
      fold(ORG_B, 'EUR', 'product', { revenue: '300.00', missing: 1, partial: 1 }),
    ], []);
    const s = await run({}, partnerScope());
    expect(s.notes).toContain(partialBundleNote(2));
    expect(s.sources.map((r) => r.partialCostBundles)).toEqual([1, 1]);
    queueExecute(NAMES, WORKED_FOLD, WORKED_HOURS);
    expect((await run({})).notes.some((n) => n.includes('bundle'))).toBe(false);
  });

  it('effective rate excludes product and AI revenue; revenue per hour includes it', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'USD', 'recurring', { revenue: '1000.00', missing: 1 }),
      fold(ORG_A, 'USD', 'labor', { revenue: '200.00', missing: 2 }),
      fold(ORG_A, 'USD', 'product', { revenue: '500.00', cbr: '500.00', cost: '300.00' }),
      fold(ORG_A, 'USD', 'ai', { revenue: '100.00', missing: 1 }),
    ], [hours(ORG_A, 'USD', 600)]);
    const s = await run({});
    expect(s.orgs[0]!.money[0]).toMatchObject({ effectiveServiceRate: 120, revenuePerHour: 180 });
    expect(s.orgs[0]!.money[0]!.mix).toEqual({ recurring: '1000.00', labor: '200.00', product: '500.00', ai: '100.00', other: '0.00' });
  });

  it('unattributed hours line at partner scope, printed once and never spread', async () => {
    queueExecute(NAMES, WORKED_FOLD, [...WORKED_HOURS, hours(null, null, 0, 0, 90)]);
    const s = await run({});
    expect(s.unattributedHours).toEqual({ total: 1.5, billable: 0, included: 0, nonBillable: 1.5 });
    expect(s.orgs.map((o) => o.orgId)).toEqual([ORG_A]);
    expect(s.rows.filter((r) => r.orgId === null)).toEqual([expect.objectContaining({ hoursTotal: 1.5, currencyCode: null })]);
  });

  it('a client with hours but no revenue in the period: no_revenue, hours-only detail row', async () => {
    queueExecute(NAMES, WORKED_FOLD, [...WORKED_HOURS, hours(ORG_B, 'USD', 120)]);
    const s = await run({}, partnerScope());
    const globex = s.orgs.find((o) => o.orgId === ORG_B)!;
    expect(globex).toMatchObject({ orgName: 'Globex', hoursAttribution: 'no_revenue', money: [] });
    expect(globex.hours.total).toBe(2);
    expect(s.rows.filter((r) => r.orgId === ORG_B)).toEqual([expect.objectContaining({ currencyCode: null, hoursTotal: 2 })]);
  });

  it('groupBy source sums per category per currency', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'USD', 'product', { revenue: '500.00', cbr: '500.00', cost: '300.00' }),
      fold(ORG_B, 'USD', 'product', { revenue: '250.00', cbr: '100.00', cost: '50.00', missing: 1 }),
      fold(ORG_B, 'EUR', 'product', { revenue: '80.00', cbr: '80.00', cost: '20.00' }),
      fold(ORG_B, 'USD', 'recurring', { revenue: '300.00', missing: 1 }),
    ], []);
    const s = await run({ groupBy: 'source' }, partnerScope());
    expect(s.groupBy).toBe('source');
    expect(s.sources.map((r) => [r.category, r.currencyCode, r.revenue, r.cost, r.grossMargin, r.linesMissingCost])).toEqual([
      ['recurring', 'USD', '300.00', '0.00', '0.00', 1],
      ['product', 'EUR', '80.00', '20.00', '60.00', 0],
      ['product', 'USD', '750.00', '350.00', '250.00', 1],
    ]);
    expect(s.sources.find((r) => r.category === 'product' && r.currencyCode === 'USD')!.costCoveragePct).toBeCloseTo(600 / 750, 12);
  });

  it('defaults: organization at partner scope, source at org scope', async () => {
    queueExecute(NAMES, [], []);
    expect((await run({})).groupBy).toBe('organization');
    queueExecute([{ id: ORG_A, name: 'Acme' }], [], [], []);
    expect((await run({}, orgScope)).groupBy).toBe('source');
  });

  it('org scope: one org, invoice detail rows, hours on the org only', async () => {
    queueExecute([{ id: ORG_A, name: 'Acme' }], WORKED_FOLD, WORKED_HOURS, [{
      invoice_id: 'inv-1', invoice_number: 'INV-1', issue_date: '2026-08-10', currency_code: 'USD',
      revenue: '1500.00', cost_bearing_revenue: '500.00', cost: '300.00', unknown_cost_revenue: '1000.00',
      lines_missing_cost: 1, partial_cost_bundles: 0,
      recurring_revenue: '1000.00', labor_revenue: '0.00', product_revenue: '500.00', ai_revenue: '0.00', other_revenue: '0.00',
      available: 1,
    }]);
    const s = await run({}, orgScope);
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
    expect(s.unattributedHours).toBeNull();
    expect(s.rows).toEqual([expect.objectContaining({
      orgId: ORG_A, orgName: 'Acme', invoiceId: 'inv-1', invoiceNumber: 'INV-1', issueDate: '2026-08-10', currencyCode: 'USD',
      revenue: '1500.00', cost: '300.00', grossMargin: '200.00', marginPct: 0.4, recurringRevenue: '1000.00', productRevenue: '500.00',
      hoursTotal: null, effectiveServiceRate: null, estimatedContributionAfterLabor: null,
    })]);
    expect(calls).toHaveLength(4);
    expect(calls[3]!.sql).toContain('/* profitability:invoice_detail */');
  });

  it('detail rows (the CSV) have a fixed column order and marginPct rounded to 1 decimal of a percent', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'USD', 'product', { revenue: '500.00', cbr: '500.00', cost: '333.33' }),
    ], [hours(ORG_A, 'USD', 300, 240, 60)]);
    const s = await run({});
    const row = s.rows[0]!;
    expect(Object.keys(row)).toEqual([
      'orgName', 'orgId', 'invoiceNumber', 'invoiceId', 'issueDate', 'currencyCode',
      'revenue', 'cost', 'grossMargin', 'marginPct', 'costCoveragePct', 'unknownCostRevenue',
      'recurringRevenue', 'laborRevenue', 'productRevenue', 'aiRevenue', 'otherRevenue',
      'hoursTotal', 'hoursBillable', 'hoursIncluded', 'hoursNonBillable',
      'effectiveServiceRate', 'estimatedContributionAfterLabor',
    ]);
    expect(row.marginPct).toBe(0.333);
    // Only the CSV row is rounded; the structured summary keeps full precision.
    expect(s.orgs[0]!.money[0]!.marginPct).not.toBe(0.333);
  });

  it('partner scope: every statement in the partner context; the name read binds the partner axis', async () => {
    ctx.current = { scope: 'partner', partnerId: PARTNER, accessibleOrgIds: [ORG_A, ORG_B], accessiblePartnerIds: [PARTNER] };
    queueExecute(NAMES, WORKED_FOLD, WORKED_HOURS);
    await run({}, partnerScope());
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['partner']));
    expect(calls[0]!.sql).toMatch(/o\.id = ANY\(.+\) AND o\.partner_id = \$\d+/);
    expect(calls[1]!.sql).toContain('/* profitability:fold */');
    expect(calls[2]!.sql).toContain('/* profitability:hours */');
    expect(calls[0]!.params).toContain(PARTNER);
  });

  it('a site-restricted authority queries nothing', async () => {
    queueExecute();
    const restricted: ReportGenerationAuthority = {
      ...orgAuthority, scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
    };
    const s = summaryOf(await generateClientProfitabilityReport(orgScope, {}, restricted));
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
    expect(s.byCurrency).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('a partner with no orgs short-circuits with NO_ORGS_NOTE', async () => {
    queueExecute();
    const s = await run({}, partnerScope([]));
    expect(s.notes[0]).toBe(NO_ORGS_NOTE);
    expect(s.notes).toContain(PARTNER_ORG_LIST_NOTE);
    expect(calls).toHaveLength(0);
  });

  it('detail cap: partner rows stop at the cap; aggregates are computed before it', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    queueExecute(
      many.map((id, i) => ({ id, name: `Org ${String(i).padStart(5, '0')}` })),
      many.map((id) => fold(id, 'USD', 'product', { revenue: '1.00', cbr: '1.00', cost: '0.50' })),
      [],
    );
    const s = await run({}, partnerScope(many));
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 5001, truncated: true });
    expect(s.rows).toHaveLength(5000);
    expect(s.byCurrency[0]).toMatchObject({ revenue: '5001.00', cost: '2500.50' });
  });

  it('org-scope detail cap: LIMIT cap + 1, available from the window count', async () => {
    queueExecute([{ id: ORG_A, name: 'Acme' }], WORKED_FOLD, [], Array.from({ length: 5001 }, (_, i) => ({
      invoice_id: `inv-${i}`, invoice_number: null, issue_date: '2026-08-10', currency_code: 'USD',
      revenue: '1.00', cost_bearing_revenue: '0.00', cost: '0.00', unknown_cost_revenue: '1.00',
      lines_missing_cost: 1, partial_cost_bundles: 0,
      recurring_revenue: '1.00', labor_revenue: '0.00', product_revenue: '0.00', ai_revenue: '0.00', other_revenue: '0.00',
      available: 7000,
    })));
    const s = await run({}, orgScope);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 7000, truncated: true });
    expect(calls[3]!.params[calls[3]!.params.length - 1]).toBe(5001);
  });

  it('JPY money stays in whole yen and rounds the labor estimate at 0 dp', async () => {
    queueExecute(NAMES, [
      fold(ORG_A, 'JPY', 'product', { revenue: '5000.00', cbr: '5000.00', cost: '3001.00' }),
      fold(ORG_A, 'JPY', 'recurring', { revenue: '10000.00', missing: 1 }),
    ], [hours(ORG_A, 'JPY', 25)]);
    const s = await run({ laborCostPerHour: { amount: '4999', currencyCode: 'JPY' } });
    // 25 min → 0.42 h × ¥4,999 = ¥2,099.58 → ¥2,100
    expect(s.orgs[0]!.money[0]).toMatchObject({ grossMargin: '1999.00', estimatedLaborCost: '2100.00', estimatedContributionAfterLabor: '9899.00' });
  });

  it('a stored config with an unknown key it refuses never runs a query', async () => {
    queueExecute();
    await expect(run({ orgIds: [ORG_A] })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('clientProfitabilityConfigSchema', () => {
  const ok = (v: unknown) => clientProfitabilityConfigSchema.safeParse(v).success;

  it('accepts a positive rate with at most 2 dp in a known currency', () => {
    expect(ok({ laborCostPerHour: { amount: '45', currencyCode: 'USD' } })).toBe(true);
    expect(ok({ laborCostPerHour: { amount: '45.5', currencyCode: 'EUR' } })).toBe(true);
    expect(ok({ laborCostPerHour: { amount: '9999999.99', currencyCode: 'GBP' } })).toBe(true);
    expect(ok({ groupBy: 'source', period: { kind: 'last_quarter' } })).toBe(true);
  });

  it('rejects a non-positive or 3-dp rate, an unknown currency and an extra key', () => {
    expect(ok({ laborCostPerHour: { amount: '0', currencyCode: 'USD' } })).toBe(false);
    expect(ok({ laborCostPerHour: { amount: '0.00', currencyCode: 'USD' } })).toBe(false);
    expect(ok({ laborCostPerHour: { amount: '-5', currencyCode: 'USD' } })).toBe(false);
    expect(ok({ laborCostPerHour: { amount: '45.125', currencyCode: 'USD' } })).toBe(false);
    expect(ok({ laborCostPerHour: { amount: '45', currencyCode: 'XYZ' } })).toBe(false);
    expect(ok({ laborCostPerHour: { amount: '45', currencyCode: 'USD', per: 'tech' } })).toBe(false);
    expect(ok({ laborCostPerHour: { amount: 45, currencyCode: 'USD' } })).toBe(false);
    expect(ok({ groupBy: 'technician' })).toBe(false);
  });

  it('a zero-decimal currency takes a whole-unit rate only', () => {
    expect(ok({ laborCostPerHour: { amount: '5000', currencyCode: 'JPY' } })).toBe(true);
    expect(ok({ laborCostPerHour: { amount: '5000.50', currencyCode: 'JPY' } })).toBe(false);
  });

  it('has no defaults anywhere (applied in the generator)', () => {
    expect(clientProfitabilityConfigSchema.parse({})).toEqual({});
  });
});
