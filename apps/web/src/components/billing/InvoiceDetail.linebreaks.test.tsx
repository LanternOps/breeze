import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InvoiceDetail from './InvoiceDetail';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const DESCRIPTION = 'Final build:\n• Dell R360\n• Windows Server 2025';

const invoice: InvoiceDetailData['invoice'] = {
  id: 'inv-1', invoiceNumber: 'INV-1', orgId: 'org-1', siteId: null, status: 'sent',
  currencyCode: 'USD', issueDate: '2026-07-01', dueDate: '2026-07-31', sentAt: null,
  subtotal: '10.00', taxRate: null, taxTotal: '0.00', total: '10.00', amountPaid: '0.00',
  balance: '10.00', billToName: 'Acme', notes: null, termsAndConditions: null,
  sellerSnapshot: null, createdAt: '2026-07-01T00:00:00.000Z', evidenceVersion: 1,
};

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockResolvedValue({
    ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }),
  } as unknown as Response);
});

describe('InvoiceDetail line description line breaks (#9401)', () => {
  it('keeps newlines visible in the blurb', () => {
    render(<InvoiceDetail onChanged={vi.fn()} detail={{
      autopay: null, invoice,
      lines: [{
        id: 'a', invoiceId: 'inv-1', sourceType: 'manual', parentLineId: null, catalogItemId: null,
        name: 'Server build', description: DESCRIPTION, quantity: '1.00', unitPrice: '10.00', costBasis: null,
        revenueAllocation: null, taxable: false, customerVisible: true, lineTotal: '10.00',
        isUnapprovedTime: false, sortOrder: 0, deviceCount: 0,
      }],
    }} />);
    const blurb = screen.getByText(/Final build:/);
    expect(blurb.className).toContain('whitespace-pre-line');
    expect(blurb.textContent).toBe(DESCRIPTION);
  });
});
