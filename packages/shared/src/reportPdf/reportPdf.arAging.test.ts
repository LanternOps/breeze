import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as arPdf from './arAgingPdf';
import type { ArAgingSummary } from '../types/businessReports';

const opts = { reportType: 'ar_aging', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

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
  'As of 2026-09-30 in America/Chicago.',
  'Invoices with no due date are reported in their own bucket and are never counted as current.',
  'Totals are reported per currency; no FX conversion is applied.',
];

function bucketRow(currencyCode: string, current: string, openTotal: string, invoiceCount: number) {
  return {
    groupKey: currencyCode,
    groupLabel: currencyCode,
    currencyCode,
    buckets: {
      current,
      d1_30: '0.00',
      d31_60: '0.00',
      d61_90: '0.00',
      d90_plus: '0.00',
      no_due_date: '0.00',
    } as const,
    openTotal,
    invoiceCount,
  };
}

const SUMMARY: ArAgingSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  asOf: '2026-09-30',
  timeZone: 'America/Chicago',
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'organization',
  byCurrency: [
    bucketRow('USD', '500.00', '700.13', 3),
    bucketRow('EUR', '100.00', '100.42', 1),
  ],
  groups: [
    { ...bucketRow('USD', '500.00', '700.13', 3), groupKey: 'o1', groupLabel: 'Acme Co' },
    { ...bucketRow('EUR', '100.00', '100.42', 1), groupKey: 'o1', groupLabel: 'Acme Co' },
  ],
  otherOpenBalance: [],
  detail: { cap: 5000, stored: 4, available: 4, truncated: false },
  notes: NOTES,
  rows: [
    {
      invoiceId: 'i1', invoiceNumber: 'INV-1', orgId: 'o1', orgName: 'Acme Co', currencyCode: 'USD',
      status: 'sent', issueDate: '2026-09-01', dueDate: '2026-09-15', total: '500.00',
      amountPaid: '0.00', balance: '500.00', daysOverdue: -10, bucket: 'current', lastPaymentAt: null,
    },
    {
      invoiceId: 'i2', invoiceNumber: 'INV-2', orgId: 'o1', orgName: 'Acme Co', currencyCode: 'EUR',
      status: 'overdue', issueDate: '2026-08-01', dueDate: '2026-08-15', total: '100.00',
      amountPaid: '0.00', balance: '100.00', daysOverdue: 20, bucket: 'current', lastPaymentAt: null,
    },
  ],
};

describe('buildReportPdf: ar_aging', () => {
  it('routes to the AR aging renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(arPdf, 'renderArAgingReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('a summary-less result falls through to the generic renderer rather than throwing', () => {
    expect(() => buildReportPdf([], opts)).not.toThrow();
  });

  // Fix round (minor): a business type that falls through to the generic
  // renderer has lost its whole designed body — never silently.
  it('reports a business-type fallback to the generic renderer through onRendererFallback', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, summary: { ...SUMMARY, asOf: undefined } as never, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ar_aging', reason: 'summary_shape_mismatch' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a summary-less business result is reported too; a legacy type never is', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ar_aging', reason: 'summary_missing' });
    onRendererFallback.mockClear();
    buildReportPdf([{ a: 1 }], { ...opts, reportType: 'device_inventory', onRendererFallback });
    expect(onRendererFallback).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prints the basis notes verbatim', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('no FX conversion is applied');
  });

  it('discloses truncation: drawn count, available count, and both caps', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...SUMMARY.rows[0]!, invoiceId: `i${i}` }));
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 9000/);
    expect(text).not.toMatch(/5000 of 9000/);
    expect(text).toMatch(/at most 500 rows/);
    expect(text).toMatch(/at most 5000/);
  });

  it('a local-only cut (under the stored cap) still names the drawn and stored counts', () => {
    const rows = Array.from({ length: 700 }, (_, i) => ({ ...SUMMARY.rows[0]!, invoiceId: `i${i}` }));
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 700, available: 700, truncated: false }, rows };
    expect(extractText(buildReportPdf([], { ...opts, summary: s }))).toMatch(/showing 500 of 700/);
  });

  it('two currencies produce two rows and no third, combined figure', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toMatch(/700\.13/);
    expect(text).toMatch(/100\.42/);
    // No summed total across currencies (700.13 + 100.42 = 800.55) is ever printed.
    expect(text).not.toMatch(/800\.55/);
  });
});
