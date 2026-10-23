import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as mrrPdf from './mrrRenewalsPdf';
import type { MrrCurrencyTotals, MrrRenewalsSummary } from '../types/businessReports';

const opts = { reportType: 'mrr_renewals', generatedAt: 'Oct 23, 2026', timezone: 'UTC' };

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

function totals(currencyCode: string, mrr: string): MrrCurrencyTotals {
  return {
    currencyCode, mrr, baseMrr: mrr, overageMrr: '0.00', finalTermMrr: '0.00', arr: '15000.00',
    contractCount: 3, pausedMrr: '0.00', pausedCount: 1, pendingActivationMrr: '0.00', pendingActivationCount: 2,
    evergreenMrr: '0.00', evergreenCount: 0,
  };
}

const SUMMARY: MrrRenewalsSummary = {
  generatedAt: '2026-10-23T05:00:00.000Z',
  measured: true,
  asOf: '2026-10-23',
  timeZone: 'UTC',
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'organization',
  renewalHorizonDays: 90,
  byCurrency: [totals('USD', '1250.00'), totals('EUR', '400.00')],
  groups: [],
  renewals: {
    totals: [{ currencyCode: 'USD', autoRenewMrr: '1000.00', autoRenewCount: 2, manualMrr: '250.00', manualCount: 1 }],
    contractIds: ['c1'],
  },
  activeNotInTerm: [
    { contractId: 'c9', contractName: 'Lapsed Support', orgName: 'Acme Co', reason: 'ended before the run date', startDate: '2025-01-01', endDate: '2026-09-01' },
  ],
  skipped: [
    { contractId: 'c8', contractName: 'Mystery Retainer', orgName: 'Acme Co', reason: 'no billing interval' },
  ],
  billedRecurring: [
    { month: '2026-09', currencyCode: 'USD', amount: '1200.00', partial: false },
    { month: '2026-10', currencyCode: 'USD', amount: '600.00', partial: true },
  ],
  detail: { cap: 5000, stored: 1, available: 1, truncated: false },
  notes: ['MRR is measured at run time; contracts keep no status history.'],
  rows: [
    {
      contractId: 'c1', contractName: 'Managed Services Gold', orgId: 'o1', orgName: 'Acme Co', status: 'active',
      basis: 'active', intervalMonths: 1, currencyCode: 'USD', baseMonthly: '1250.00', overageMonthly: '0.00',
      mrr: '1250.00', startDate: '2025-12-01', endDate: '2026-12-01', daysRemaining: 39, autoRenew: true,
      renewalTermMonths: 12, inRenewalWindow: true, advanceNoticeSentAt: null,
    },
  ],
};

describe('buildReportPdf: mrr_renewals', () => {
  it('renders the designed arm, not the generic table', () => {
    const spy = vi.spyOn(mrrPdf, 'renderMrrRenewalsReport');
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(spy).toHaveBeenCalledOnce();
    expect(text).toContain('Billed recurring revenue');
    // No cross-currency total (1250.00 + 400.00).
    expect(text).not.toMatch(/1,?650\.00/);
    spy.mockRestore();
  });

  it('previous chip says "previous observation" with the prior run date and per-currency delta', () => {
    const previous = {
      generatedAt: '2026-09-23T05:00:00.000Z',
      summary: { asOf: '2026-09-23', byCurrency: [totals('USD', '1000.00')] },
    };
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY, previous }));
    // PDF text strings escape parentheses.
    expect(text).toMatch(/vs previous observation \\?\(2026-09-23\\?\)/);
    expect(text).toMatch(/\+\$250\.00/);
    expect(text).not.toMatch(/last month/i);
  });

  it('a previous summary in another shape renders no chip', () => {
    const previous = { generatedAt: '2026-09-23T05:00:00.000Z', summary: { postureScore: 80 } };
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY, previous }));
    expect(text).not.toContain('previous observation');
  });

  it('skipped contracts are printed', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('Mystery Retainer');
    expect(text).toContain('no billing interval');
  });

  it('an unmeasured run (site-restricted / no organizations) says "not measured", never "no contracts"', () => {
    const unmeasured: MrrRenewalsSummary = {
      ...SUMMARY, measured: false, byCurrency: [], groups: [], renewals: { totals: [], contractIds: [] },
      activeNotInTerm: [], skipped: [], billedRecurring: [], rows: [],
      detail: { cap: 5000, stored: 0, available: 0, truncated: false },
      notes: ['This report ran under a site-restricted authority.'],
    };
    const text = extractText(buildReportPdf([], { ...opts, summary: unmeasured }));
    expect(text).toContain('Not measured');
    expect(text).toContain('site-restricted');
    expect(text).not.toContain('No in-term contracts');
    expect(text).not.toContain('Nothing to reconcile');
    expect(text).not.toContain('No contracts reach their end date');
  });

  it('a stored run from before the measured flag renders as measured', () => {
    const legacy = { ...SUMMARY } as Partial<MrrRenewalsSummary>;
    delete legacy.measured;
    const text = extractText(buildReportPdf([], { ...opts, summary: legacy as MrrRenewalsSummary }));
    expect(text).toContain('Managed Services Gold');
    expect(text).not.toContain('Not measured');
  });

  it('renewing contracts beyond the stored detail rows are counted, not silently dropped', () => {
    const capped = { ...SUMMARY, renewals: { ...SUMMARY.renewals, contractIds: ['c1', 'c-beyond-cap-1', 'c-beyond-cap-2'] } };
    const text = extractText(buildReportPdf([], { ...opts, summary: capped }));
    expect(text).toContain('Managed Services Gold');
    expect(text).toContain('2 more renewing contracts are not listed');
  });

  it('shape mismatch reports onRendererFallback summary_shape_mismatch', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, summary: { ...SUMMARY, byCurrency: undefined } as never, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'mrr_renewals', reason: 'summary_shape_mismatch' });
    warn.mockRestore();
  });
});

describe('mrr_renewals pagination', () => {
  /** Top-down y (mm) of every text run containing `needle`, with its page number. */
  function textYs(doc: ReturnType<typeof buildReportPdf>, needle: string): Array<{ page: number; yMm: number }> {
    const pages = (doc.internal as unknown as { pages: Array<string[] | undefined> }).pages;
    const pageH = doc.internal.pageSize.getHeight();
    const out: Array<{ page: number; yMm: number }> = [];
    pages.forEach((p, page) => {
      if (!Array.isArray(p)) return;
      const stream = p.join('\n');
      const re = /([\d.]+) ([\d.]+) Td\s*\((.*?)\)\s*Tj/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stream))) {
        if (m[3]?.includes(needle)) out.push({ page, yMm: pageH - Number(m[2]) / doc.internal.scaleFactor });
      }
    });
    return out;
  }

  it('keeps the Reconciliation heading and prose above the footer when earlier content overflows', () => {
    const skipped = Array.from({ length: 70 }, (_, i) => ({
      contractId: `s${i}`, contractName: `Skipped Contract ${i}`, orgName: 'Acme Co', reason: 'no billing interval',
    }));
    const doc = buildReportPdf([], { ...opts, summary: { ...SUMMARY, skipped } });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const heading = textYs(doc, 'Reconciliation');
    expect(heading.length).toBeGreaterThan(0);
    const all = [...heading, ...textYs(doc, 'Skipped Contract')];
    expect(all.length).toBeGreaterThan(60);
    // footY is 199 mm on the 210 mm landscape page; nothing may be drawn below it.
    for (const t of all) expect(t.yMm).toBeLessThan(199);
  });
});
