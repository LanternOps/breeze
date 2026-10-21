import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InvoiceDocument } from './InvoiceDocument';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [{ id: 'org-1', name: 'Acme Industries' }] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const DESCRIPTION = 'Final build:\n• Dell R360\n• Windows Server 2025';

const detail: InvoiceDetailData = {
  autopay: null,
  invoice: {
    id: 'inv-1', invoiceNumber: 'INV-0007', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-30', sentAt: null, subtotal: '120.00',
    taxRate: '0.000', taxTotal: '0.00', total: '120.00', amountPaid: '0.00', balance: '120.00',
    billToName: 'Acme', notes: null, termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
  },
  lines: [
    {
      id: 'l1', invoiceId: 'inv-1', sourceType: 'catalog', parentLineId: null, catalogItemId: 'c1',
      name: 'Server build', description: DESCRIPTION, quantity: '1.00', unitPrice: '120.00', costBasis: null, revenueAllocation: '120.00',
      taxable: true, customerVisible: true, lineTotal: '120.00', isUnapprovedTime: false, sortOrder: 0, deviceCount: 0,
    },
  ],
};

describe('InvoiceDocument line description line breaks (#9401)', () => {
  it('keeps newlines visible in the blurb', () => {
    render(<InvoiceDocument detail={detail} customerName="Acme Industries" />);
    const blurb = screen.getByText(/Final build:/);
    expect(blurb.className).toContain('whitespace-pre-line');
    expect(blurb.textContent).toBe(DESCRIPTION);
    expect(blurb.textContent).toContain('\n');
  });
});
