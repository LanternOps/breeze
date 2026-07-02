import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InvoiceDocument } from './InvoiceDocument';
import InvoiceDocumentPreview from './InvoiceDocument';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';

// InvoiceDocument is presentational, but its module imports the auth/org stores
// and navigation (used by the PDF-download affordance). Mock them so the unit
// renders without real store initialization or network.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [{ id: 'org-1', name: 'Acme Industries' }] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// A billed line carrying a cost, plus a hidden bundle child that also carries a
// cost — neither the cost nor the hidden component may surface on the customer
// document.
const detail: InvoiceDetailData = {
  invoice: {
    id: 'inv-1', invoiceNumber: 'INV-0007', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-06-01', dueDate: '2026-06-30', sentAt: null, subtotal: '120.00',
    taxRate: '0.000', taxTotal: '0.00', total: '120.00', amountPaid: '0.00', balance: '120.00',
    billToName: 'Acme', notes: null, termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-06-01T00:00:00Z',
  },
  lines: [
    {
      id: 'l1', invoiceId: 'inv-1', sourceType: 'catalog', parentLineId: null, catalogItemId: 'c1',
      name: null, description: 'Widget', quantity: '1.00', unitPrice: '120.00', costBasis: '80.00', revenueAllocation: '120.00',
      taxable: true, customerVisible: true, lineTotal: '120.00', isUnapprovedTime: false, sortOrder: 0,
    },
    {
      id: 'l2', invoiceId: 'inv-1', sourceType: 'bundle', parentLineId: 'l1', catalogItemId: 'c2',
      name: null, description: 'Secret component', quantity: '1.00', unitPrice: '0.00', costBasis: '10.00', revenueAllocation: null,
      taxable: false, customerVisible: false, lineTotal: '0.00', isUnapprovedTime: false, sortOrder: 1,
    },
  ],
};

describe('InvoiceDocument — customer-facing, no internal cost', () => {
  it('renders billed lines but never the cost, margin, or hidden components', () => {
    render(<InvoiceDocument detail={detail} customerName="Acme Industries" />);
    expect(screen.getByTestId('invoice-document')).toBeInTheDocument();

    // The customer DOES see the line and its price/total.
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getAllByText('$120.00').length).toBeGreaterThan(0);

    // Internal cost figures must NOT leak: neither the per-unit cost ($80.00 /
    // $10.00) nor a margin/cost label, nor the hidden bundle child.
    expect(screen.queryByText('$80.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$10.00')).not.toBeInTheDocument();
    expect(screen.queryByText(/margin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Cost$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Secret component')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-margin')).not.toBeInTheDocument();
  });
});

describe('InvoiceDocumentPreview — customer-name fallback', () => {
  it('falls back to an em-dash (never a raw org UUID fragment) when neither billToName nor the org store resolves', () => {
    const d: InvoiceDetailData = {
      ...detail,
      invoice: {
        ...detail.invoice,
        billToName: null, // no explicit bill-to
        orgId: '9f8e7d6c-1234-4abc-9def-0123456789ab', // not in the mocked org store
      },
    };
    render(<InvoiceDocumentPreview detail={d} />);
    const customer = screen.getByTestId('invoice-document-customer');
    expect(customer).toHaveTextContent('—');
    // The UUID (or its first 8 chars) must never leak onto the customer document.
    expect(customer).not.toHaveTextContent('9f8e7d6c');
  });
});
