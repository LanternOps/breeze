import { describe, expect, it, vi } from 'vitest';

// Pass-through spy on autoTable so row-level invariants can be asserted on the
// head/body handed to it (drawn text alone cannot tell which cells share a row).
vi.mock('jspdf-autotable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jspdf-autotable')>();
  return { ...actual, default: vi.fn(actual.default) };
});

import autoTable from 'jspdf-autotable';
import { buildReportPdf } from './reportPdf';
import * as cpPdf from './clientProfitabilityPdf';
import {
  emptyClientProfitabilitySummary,
  type ClientProfitabilityDetailRow,
  type ClientProfitabilityOrgRow,
  type ClientProfitabilitySummary,
  type ProfitabilityMoneyRow,
} from '../types/businessReports';

const opts = { reportType: 'client_profitability', generatedAt: 'Oct 23, 2026', timezone: 'UTC' };

const CP1252_HIGH =
  '€‚ƒ„…†‡'
  + 'ˆ‰Š‹ŒŽ'
  + '‘’“”•–—'
  + '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function extractText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

// Loosely typed on purpose: tests index into rows freely (strict-index would flag every cell).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TableCall = { head: any[]; body: any[] };
function tableCalls(): TableCall[] {
  return (autoTable as unknown as { mock: { calls: Array<[unknown, TableCall]> } }).mock.calls.map((c) => ({ head: (c[1].head as unknown[][])[0] ?? [], body: c[1].body }));
}

function money(over: Partial<ProfitabilityMoneyRow> = {}): ProfitabilityMoneyRow {
  return {
    currencyCode: 'USD',
    revenue: '1000.00',
    costBearingRevenue: '800.00',
    cost: '500.00',
    grossMargin: '300.00',
    marginPct: 0.375,
    costCoveragePct: 0.8,
    unknownCostRevenue: '200.00',
    linesMissingCost: 2,
    partialCostBundles: 0,
    mix: { recurring: '600.00', labor: '200.00', product: '100.00', ai: '50.00', other: '50.00' },
    effectiveServiceRate: 100,
    revenuePerHour: 125,
    estimatedLaborCost: null,
    estimatedContributionAfterLabor: null,
    nullCostRecurringRevenue: '0.00',
    excludedUnknownCostRevenue: '0.00',
    ...over,
  };
}

const HOURS = { total: 8, billable: 4, included: 3, nonBillable: 1 };

function orgRow(name: string, m: ProfitabilityMoneyRow[]): ClientProfitabilityOrgRow {
  return {
    orgId: name, orgName: name, hours: HOURS, money: m,
    hoursAttribution: m.length === 0 ? 'no_revenue' : 'single_currency',
  };
}

function invoiceRow(): ClientProfitabilityDetailRow {
  return {
    orgId: 'o1', orgName: 'Acme Co', invoiceId: 'i1', invoiceNumber: 'INV-0042', issueDate: '2026-09-05',
    currencyCode: 'USD', revenue: '500.00', cost: '200.00', grossMargin: '300.00', marginPct: 0.6,
    costCoveragePct: 0.9, unknownCostRevenue: '50.00', recurringRevenue: null, laborRevenue: null,
    productRevenue: null, aiRevenue: null, otherRevenue: null, hoursTotal: null, hoursBillable: null,
    hoursIncluded: null, hoursNonBillable: null, effectiveServiceRate: null, estimatedContributionAfterLabor: null,
  };
}

function partnerSummary(over: Partial<ClientProfitabilitySummary> = {}): ClientProfitabilitySummary {
  return {
    ...emptyClientProfitabilitySummary('Margin is measured over cost-bearing lines only.'),
    period: { kind: 'last_full_month', start: '2026-09-01', end: '2026-09-30', label: 'September 2026', timeZone: 'UTC' },
    scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
    byCurrency: [money({ revenue: '1900.00', grossMargin: '560.00' })],
    orgs: [
      orgRow('Acme Co', [money()]),
      orgRow('Globex Inc', [money({ revenue: '900.00', grossMargin: '260.00', marginPct: 0.4, costCoveragePct: 0.72 })]),
    ],
    detail: { cap: 5000, stored: 0, available: 0, truncated: false },
    ...over,
  };
}

const ORG_SCOPE = { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' } as const;

const build = (summary: ClientProfitabilitySummary) =>
  extractText(buildReportPdf([], { ...opts, summary }));

describe('buildReportPdf: client_profitability', () => {
  it('renders the designed arm (no shape-mismatch fallback)', () => {
    const spy = vi.spyOn(cpPdf, 'renderClientProfitabilityReport');
    const onRendererFallback = vi.fn();
    const text = extractText(buildReportPdf([], { ...opts, summary: partnerSummary(), onRendererFallback }));
    expect(spy).toHaveBeenCalledOnce();
    expect(onRendererFallback).not.toHaveBeenCalled();
    expect(text).toContain('Client Profitability');
    expect(text).toContain('Acme Co');
    expect(text).toContain('Globex Inc');
    spy.mockRestore();
  });

  it('prints cost coverage % in the column right beside every margin %', () => {
    vi.mocked(autoTable).mockClear();
    build(partnerSummary({ scope: ORG_SCOPE, rows: [invoiceRow()] }));
    const withMargin = tableCalls().filter((t) => t.head.some((h) => /^Margin %/.test(h)));
    // scorecard + per-client + invoice detail
    expect(withMargin.length).toBeGreaterThanOrEqual(3);
    for (const t of withMargin) {
      const i = t.head.findIndex((h) => /^Margin %/.test(h));
      expect(t.head[i + 1]).toMatch(/^Cost coverage %/);
      for (const row of t.body) {
        if (row[i] !== 'N/A') expect(row[i + 1]).not.toBe('N/A');
      }
    }
    // the fixture's own values land in the same row
    const clientTable = withMargin.find((t) => t.head[0] === 'Client')!;
    const acme = clientTable.body.find((r) => r[0] === 'Acme Co')!;
    expect(acme).toContain('37.5%');
    expect(acme).toContain('80.0%');
    const invoiceTable = withMargin.find((t) => t.head[0] === 'Invoice')!;
    expect(invoiceTable.body[0]).toContain('60.0%');
    expect(invoiceTable.body[0]).toContain('90.0%');
  });

  it('an unmeasured margin prints N/A, never 0%', () => {
    vi.mocked(autoTable).mockClear();
    const text = build(partnerSummary({
      orgs: [orgRow('Acme Co', [money({ marginPct: null, costCoveragePct: 0.4, effectiveServiceRate: null })])],
    }));
    const clientTable = tableCalls().find((t) => t.head[0] === 'Client')!;
    const i = clientTable.head.findIndex((h) => /^Margin %/.test(h));
    expect(clientTable.body[0][i]).toBe('N/A');
    expect(clientTable.body[0][i + 1]).toBe('40.0%');
    expect(clientTable.body[0].join('|')).not.toMatch(/(^|\|)0(\.0)?%/);
    expect(text).toContain('N/A');
  });

  it('a client with no revenue prints its hours with blank money', () => {
    vi.mocked(autoTable).mockClear();
    build(partnerSummary({ orgs: [orgRow('Initech', [])] }));
    const clientTable = tableCalls().find((t) => t.head[0] === 'Client')!;
    const row = clientTable.body.find((r) => r[0] === 'Initech')!;
    expect(row).toBeDefined();
    expect(row.join('|')).toContain('8.00');
    expect(row.join('|')).not.toContain('$');
  });

  it('omits the estimate block when laborCostPerHour is null', () => {
    const text = build(partnerSummary({ laborCostPerHour: null }));
    expect(text).not.toContain('Estimated contribution after labor');
    expect(text).not.toContain('Estimate');
  });

  it('prints the estimate block, badged Estimate, when a labor rate is set', () => {
    vi.mocked(autoTable).mockClear();
    const est = money({
      estimatedLaborCost: '520.00', estimatedContributionAfterLabor: '-40.00',
      nullCostRecurringRevenue: '150.00', excludedUnknownCostRevenue: '75.00',
    });
    const text = build(partnerSummary({
      laborCostPerHour: { amount: '65.00', currencyCode: 'USD' },
      byCurrency: [est],
      orgs: [orgRow('Acme Co', [est]), orgRow('Globex Inc', [money()])],
    }));
    expect(text).toMatch(/Estimated contribution after labor \\?\(uniform rate\\?\)/);
    expect(text).toContain('Estimate');
    expect(text).toContain('65.00');
    const t = tableCalls().find((c) => c.head.some((h) => /Estimated labor cost/.test(h)))!;
    expect(t.head.join('|')).toContain('of which recurring revenue with no recorded cost');
    const acme = t.body.find((r) => r[0] === 'Acme Co')!;
    expect(acme.join('|')).toContain('$520.00');
    expect(acme.join('|')).toContain('$150.00');
    expect(acme.join('|')).toContain('$75.00');
    // Globex has a null estimate: a dash, not $0.00
    const globex = t.body.find((r) => r[0] === 'Globex Inc')!;
    expect(globex.slice(2, 5)).toEqual(['-', '-', '-']);
  });

  it('groupBy source prints the category labels with coverage beside margin', () => {
    vi.mocked(autoTable).mockClear();
    const src = (category: 'recurring' | 'labor' | 'product' | 'ai' | 'other') => ({
      category, currencyCode: 'USD', revenue: '100.00', costBearingRevenue: '80.00', cost: '50.00',
      grossMargin: '30.00', marginPct: 0.375, costCoveragePct: 0.8, unknownCostRevenue: '20.00', linesMissingCost: 1, partialCostBundles: 0,
    });
    const text = build(partnerSummary({
      groupBy: 'source', orgs: [],
      sources: [src('recurring'), src('labor'), src('product'), src('ai'), src('other')],
    }));
    for (const label of ['Recurring', 'Labor', 'Product', 'AI', 'Other']) expect(text).toContain(label);
    const t = tableCalls().find((c) => c.head[0] === 'Category')!;
    const i = t.head.findIndex((h) => /^Margin %/.test(h));
    expect(t.head[i + 1]).toMatch(/^Cost coverage %/);
    expect(t.body).toHaveLength(5);
  });

  it('organization scope prints the invoice rows', () => {
    const text = build(partnerSummary({ scope: ORG_SCOPE, rows: [invoiceRow()] }));
    expect(text).toContain('INV-0042');
    expect(text).toContain('2026-09-05');
  });

  it('prints the internal / unattributed time line only when set', () => {
    expect(build(partnerSummary({ unattributedHours: { total: 5, billable: 0, included: 0, nonBillable: 5 } })))
      .toContain('Internal / unattributed time');
    expect(build(partnerSummary({ unattributedHours: null }))).not.toContain('Internal / unattributed time');
  });

  it('prints every note and the detail-truncation line', () => {
    const text = build(partnerSummary({
      notes: ['First basis note.', 'Second basis note.'],
      detail: { cap: 5000, stored: 1, available: 9000, truncated: true },
      rows: [invoiceRow()],
      scope: ORG_SCOPE,
    }));
    expect(text).toContain('First basis note.');
    expect(text).toContain('Second basis note.');
    expect(text).toContain('showing 1 of 9000');
  });

  it('shape mismatch reports onRendererFallback summary_shape_mismatch', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, summary: { ...partnerSummary(), sources: undefined } as never, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'client_profitability', reason: 'summary_shape_mismatch' });
    warn.mockRestore();
  });
});

describe('client_profitability pagination', () => {
  /** Top-down y (mm) of every text run containing `needle`. */
  function textYs(doc: ReturnType<typeof buildReportPdf>, needle: string): number[] {
    const pages = (doc.internal as unknown as { pages: Array<string[] | undefined> }).pages;
    const pageH = doc.internal.pageSize.getHeight();
    const out: number[] = [];
    pages.forEach((p) => {
      if (!Array.isArray(p)) return;
      const re = /([\d.]+) ([\d.]+) Td\s*\((.*?)\)\s*Tj/g;
      let m: RegExpExecArray | null;
      const stream = p.join('\n');
      while ((m = re.exec(stream))) {
        if (m[3]?.includes(needle)) out.push(pageH - Number(m[2]) / doc.internal.scaleFactor);
      }
    });
    return out;
  }

  it('never strands a section heading at the foot of a page, wherever earlier content ends', () => {
    for (let n = 0; n <= 30; n++) {
      const orgs = Array.from({ length: n }, (_, i) => orgRow(`Client ${i}`, [money()]));
      const doc = buildReportPdf([], { ...opts, summary: partnerSummary({ orgs }) });
      for (const needle of ['By client', 'By revenue source', 'Revenue mix', 'Hours by coverage', 'Profitability per currency']) {
        for (const y of textYs(doc, needle)) {
          expect(y, `${needle} with ${n} clients`).toBeLessThan(199 - 14);
        }
      }
    }
  });
});
