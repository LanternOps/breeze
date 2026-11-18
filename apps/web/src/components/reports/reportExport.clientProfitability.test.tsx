import { describe, it, expect, vi, beforeEach } from 'vitest';

const blobs: Blob[] = [];

vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: (b: Blob) => { blobs.push(b); } }));

import { exportReport } from './reportExport';
import { emptyClientProfitabilitySummary } from '@breeze/shared';

describe('exportReport: client_profitability', () => {
  beforeEach(() => {
    blobs.length = 0;
  });

  it('CSV rows are raw numerics with currencyCode, never formatted money', async () => {
    await exportReport(
      [{ orgName: 'Acme', currencyCode: 'USD', revenue: '1250.00', laborCost: '450.00' }],
      { format: 'csv', reportType: 'client_profitability', timezone: 'UTC' },
    );
    const csv = await blobs[0]!.text();
    expect(csv).toContain('Acme');
    expect(csv).toContain('1250.00');
    expect(csv).toContain('USD');
    expect(csv).not.toContain('$1,250.00');
  });

  it('accepts a ClientProfitabilitySummary as the export summary', async () => {
    const summary = emptyClientProfitabilitySummary('No billed revenue.');
    await exportReport([{ orgName: 'Globex', currencyCode: 'USD', revenue: '10.00' }], { format: 'csv', reportType: 'client_profitability', timezone: 'UTC', summary });
    expect(blobs).toHaveLength(1);
  });
});
