import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as winRatePdf from './quoteWinRatePdf';
import type { QuoteWinRateSummary } from '../types/businessReports';

const opts = { reportType: 'quote_win_rate', generatedAt: 'Sep 15, 2026', timezone: 'UTC' };

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

const NOTES = [
  'Win rate counts decided opportunities only: won divided by won, lost and expired. Opportunities still open are shown beside it and are not in the denominator.',
  'Values are reported per quote currency; no FX conversion is applied.',
  'Accepted quotes create draft contracts, and this report does not follow them further. See the MRR & renewals report (pending activation) for contracts waiting to go live.',
];

const counts = { lineages: 10, won: 4, lost: 2, expired: 1, open: 3, anomalies: 0, viewed: 8 };
const rates = { winRate: 4 / 7, closeRate: 0.4, viewedRate: 0.8, medianDaysToWin: 4.3, medianDaysToLoss: 2 };
const usd = { currencyCode: 'USD', quotedOneTime: '1100.00', wonOneTime: '400.00', quotedMonthlyRecurring: '40.00', wonMonthlyRecurring: '40.00', valueWinRate: 0.423 };
const eur = { currencyCode: 'EUR', quotedOneTime: '250.00', wonOneTime: '0.00', quotedMonthlyRecurring: '0.00', wonMonthlyRecurring: '0.00', valueWinRate: 0 };

const SUMMARY: QuoteWinRateSummary = {
  generatedAt: '2026-09-15T12:00:00.000Z',
  period: { kind: 'last_full_month', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z', label: 'August 2026', timeZone: 'America/Chicago' },
  scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
  groupBy: 'organization',
  overall: { ...counts, ...rates, money: [eur, usd] },
  groups: [
    { groupKey: 'o1', groupLabel: 'Acme Co', ...counts, ...rates, lineages: 8, won: 4, money: [usd] },
    { groupKey: 'o2', groupLabel: 'Globex', ...counts, ...rates, lineages: 2, won: 0, winRate: null, closeRate: 0, money: [eur] },
  ],
  diagnostics: { unreachable: 0, depthCapped: 0 },
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    { rootQuoteId: 'r1', terminalQuoteId: 't1', quoteNumber: 'Q-1-R2', orgId: 'o1', orgName: 'Acme Co', authorName: 'Dana Tech',
      versions: 2, firstSentAt: '2026-08-02T10:00:00.000Z', outcome: 'won', outcomeAt: '2026-08-12T10:00:00.000Z',
      currencyCode: 'USD', oneTimeTotal: '400.00', monthlyRecurringValue: '40.00', declineReason: null },
    { rootQuoteId: 'r2', terminalQuoteId: 't2', quoteNumber: 'Q-2', orgId: 'o2', orgName: 'Globex', authorName: 'Unknown user',
      versions: 1, firstSentAt: '2026-08-10T10:00:00.000Z', outcome: 'lost', outcomeAt: '2026-08-14T10:00:00.000Z',
      currencyCode: 'EUR', oneTimeTotal: '250.00', monthlyRecurringValue: '0.00', declineReason: 'Went with another vendor' },
  ],
};

describe('buildReportPdf: quote_win_rate', () => {
  it('routes to the designed quote win rate renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(winRatePdf, 'renderQuoteWinRateReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('reports a missing or wrong-shaped summary through onRendererFallback (designed type, never silent)', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'quote_win_rate', reason: 'summary_missing' });
    onRendererFallback.mockClear();
    buildReportPdf([], { ...opts, summary: { ...SUMMARY, overall: undefined } as never, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'quote_win_rate', reason: 'summary_shape_mismatch' });
    warn.mockRestore();
  });

  it('headline is the decided-only win rate with the open count beside it', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('Quote win rate');
    expect(text).toContain('57.1%'); // 4 / 7
    expect(text).toMatch(/3 still open/);
    expect(text).toMatch(/4 won/);
  });

  it('prints close rate, viewed rate and the medians', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('40.0%'); // close rate
    expect(text).toContain('80.0%'); // viewed rate
    expect(text).toMatch(/4\.3 days/);
    expect(text).toMatch(/2\.0 days|2 days/);
  });

  it('an unmeasured win rate prints N/A, never 0%', () => {
    const s: QuoteWinRateSummary = {
      ...SUMMARY,
      overall: { ...SUMMARY.overall, won: 0, lost: 0, expired: 0, open: 2, lineages: 2, viewed: 0,
        winRate: null, closeRate: 0, viewedRate: 0, medianDaysToWin: null, medianDaysToLoss: null, money: [] },
      groups: [], rows: [], detail: { cap: 5000, stored: 0, available: 0, truncated: false },
    };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toContain('N/A');
    expect(text).toMatch(/2 still open/);
  });

  it('two currencies produce two money rows and never a combined figure', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toMatch(/1,100\.00/);
    expect(text).toMatch(/250\.00/);
    // 1100 + 250 = 1350 must never appear.
    expect(text).not.toMatch(/1,350\.00/);
  });

  it('prints the basis notes verbatim, including the decided-only denominator and the no-conversion caveat', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('decided opportunities only');
    expect(text).toContain('no FX conversion is applied');
    expect(text).toContain('pending activation');
  });

  it('prints the period label with its timezone and the grouping heading', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('August 2026');
    expect(text).toContain('America/Chicago');
    expect(text).toContain('By organization');
    expect(text).toContain('Acme Co');
  });

  it('the detail table lists the lineage outcome and the decline reason', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('Q-1-R2');
    expect(text).toContain('Went with another vendor');
  });

  it('discloses truncation: drawn count, available count, and both caps', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...SUMMARY.rows[0]!, quoteNumber: `Q-${i}` }));
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 9000/);
    expect(text).toMatch(/at most 500 rows/);
    expect(text).toMatch(/at most 5000/);
  });
});

describe('quote_win_rate pagination', () => {
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
    // Sweep the amount of preceding prose so some heading lands in the last ~40 pt of a page.
    for (let n = 0; n <= 30; n++) {
      const notes = Array.from({ length: n }, (_, i) => `Basis note ${i}.`);
      const doc = buildReportPdf([], { ...opts, summary: { ...SUMMARY, notes } });
      for (const needle of ['By organization', 'Value per currency', 'Win rate', 'Opportunities']) {
        for (const y of textYs(doc, needle)) {
          // footY is 199 mm; a heading needs room for at least a table row below it.
          expect(y, `${needle} with ${n} notes`).toBeLessThan(199 - 14);
        }
      }
    }
  });
});
