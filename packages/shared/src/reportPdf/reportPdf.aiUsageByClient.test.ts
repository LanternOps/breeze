import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as aiPdf from './aiUsageByClientPdf';
import type { AiUsageByClientSummary } from '../types/businessReports';

const opts = { reportType: 'ai_usage_by_client', generatedAt: 'Nov 30, 2026', timezone: 'UTC' };

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
  'Charges bill by UTC calendar month of the ledger write; this report\'s period is in America/Chicago so month-edge rows can differ from the invoice.',
  'Chargeable amounts are reported per billing-profile currency; no FX conversion is applied.',
];

const totals = (over: Partial<AiUsageByClientSummary['overall']> = {}) => ({
  requests: 4, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
  costUsd: '15.90', includedCostUsd: '5.00', unpricedRequests: 1, charges: [], ...over,
});

const SUMMARY: AiUsageByClientSummary = {
  generatedAt: '2026-09-01T05:18:00.000Z',
  period: { kind: 'last_full_month', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z', label: 'August 2026', timeZone: 'America/Chicago' },
  scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
  groupBy: 'organization',
  overall: totals({
    requests: 6, costUsd: '31.90',
    charges: [
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ],
  }),
  groups: [
    { groupKey: 'o1', groupLabel: 'Acme Co', ...totals({ charges: [{ currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' }] }) },
    { groupKey: 'o2', groupLabel: 'Globex', ...totals({ requests: 2, costUsd: '16.00', includedCostUsd: '0.00', unpricedRequests: 0,
      charges: [{ currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' }] }) },
  ],
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    { orgId: 'o1', orgName: 'Acme Co', model: 'model-alpha', currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10', ...totals() },
    { orgId: 'o2', orgName: 'Globex', model: 'model-beta', currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01', ...totals({ requests: 1 }) },
  ],
};

describe('buildReportPdf: ai_usage_by_client', () => {
  it('routes to the AI usage renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(aiPdf, 'renderAiUsageByClientReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('a summary-less result falls through to the generic renderer rather than throwing', () => {
    expect(() => buildReportPdf([], opts)).not.toThrow();
  });

  it('reports a missing or wrong-shaped summary through onRendererFallback (designed type, never silent)', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ai_usage_by_client', reason: 'summary_missing' });
    onRendererFallback.mockClear();
    buildReportPdf([], { ...opts, summary: { ...SUMMARY, period: undefined } as never, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ai_usage_by_client', reason: 'summary_shape_mismatch' });
    warn.mockRestore();
  });

  it('prints the basis notes verbatim, including the UTC-month boundary caveat', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('month-edge rows can differ from the invoice');
    expect(text).toContain('no FX conversion is applied');
  });

  it('prints the title and the period label with its timezone', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('AI usage by client');
    expect(text).toContain('August 2026');
    expect(text).toContain('America/Chicago');
  });

  it('two currencies produce two money rows and never a combined figure', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toMatch(/15\.45/);
    expect(text).toMatch(/20\.01/);
    // 15.45 + 20.01 = 35.46 must never appear.
    expect(text).not.toMatch(/35\.46/);
  });

  it('prints Breeze cost in USD and the unpriced count, separate from chargeable money', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toMatch(/15\.90/);
    expect(text).toMatch(/Unpriced/);
  });

  it('discloses truncation: drawn count, available count, and both caps', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...SUMMARY.rows[0]!, model: `m${i}` }));
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 9000/);
    expect(text).toMatch(/at most 500 rows/);
    expect(text).toMatch(/at most 5000/);
  });

  it('an empty summary renders the explanatory note, not a table of zeros', () => {
    const s: AiUsageByClientSummary = { ...SUMMARY, groups: [], rows: [], overall: totals({ requests: 0, costUsd: '0.00', includedCostUsd: '0.00', unpricedRequests: 0 }),
      detail: { cap: 5000, stored: 0, available: 0, truncated: false } };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/No AI usage in the covered scope/);
  });
});
