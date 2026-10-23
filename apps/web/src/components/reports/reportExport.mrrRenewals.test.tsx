import { describe, it, expect, vi, beforeEach } from 'vitest';

const textCalls: string[] = [];
const blobs: Blob[] = [];

vi.mock('jspdf', () => {
  const doc = {
    setFontSize: () => doc, setTextColor: () => doc, setFont: () => doc, setFillColor: () => doc,
    setDrawColor: () => doc, setLineCap: () => doc, setLineJoin: () => doc, setLineWidth: () => doc,
    rect: () => doc, roundedRect: () => doc, circle: () => doc, line: () => doc, lines: () => doc,
    addImage: () => doc, getTextWidth: () => 10,
    text: (t: unknown) => { textCalls.push(String(t)); return doc; },
    addPage: () => doc, splitTextToSize: (t: string) => [t],
    output: () => new Blob(['pdf'], { type: 'application/pdf' }),
    getCurrentPageInfo: () => ({ pageNumber: 1 }), getNumberOfPages: () => 1, putTotalPages: () => doc,
    internal: { pageSize: { getWidth: () => 842, getHeight: () => 595 } },
    lastAutoTable: { finalY: 100 },
  };
  const ctor = function () { return doc; } as unknown as () => typeof doc;
  return { jsPDF: ctor, default: ctor };
});
vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));
vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: (b: Blob) => { blobs.push(b); } }));

import { exportReport } from './reportExport';
import type { ReportBranding } from '@breeze/shared/reportPdf';
import { emptyMrrRenewalsSummary } from '@breeze/shared';

const noBranding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

describe('exportReport: mrr_renewals', () => {
  beforeEach(() => {
    textCalls.length = 0;
    blobs.length = 0;
  });

  it('CSV rows are raw numerics with currencyCode', async () => {
    await exportReport(
      [{ contractName: 'Gold', currencyCode: 'USD', mrr: '1250.00', baseMonthly: '1250.00' }],
      { format: 'csv', reportType: 'mrr_renewals', timezone: 'UTC' },
    );
    const csv = await blobs[0]!.text();
    expect(csv).toContain('1250.00');
    expect(csv).toContain('USD');
    expect(csv).not.toContain('$1,250.00');
  });

  it('reaches the MRR & Renewals arm, not renderGenericReport', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'mrr_renewals',
      timezone: 'UTC',
      summary: emptyMrrRenewalsSummary('No contracts.'),
      branding: noBranding,
    });
    expect(textCalls).toContain('MRR & Renewals');
  });
});
