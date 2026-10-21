import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOICE_DTO_FIXTURES, type CustomerInvoiceDocument } from '@breeze/shared/documents';

import InvoiceDocumentPreview from './InvoiceDocument';
import type { InvoiceDetail as InvoiceDetailData } from './invoiceTypes';
import { i18n } from '../../lib/i18n';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// The staff payload: a hidden line carrying a secret and an internal note on the invoice.
// The customer-view fixture lacks both — the Preview must render only the latter.
const detail: InvoiceDetailData = {
  autopay: null,
  invoice: {
    id: 'inv-1', invoiceNumber: 'INV-0042', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-03-01', dueDate: '2026-03-31', sentAt: null, subtotal: '300.00',
    taxRate: '0.000', taxTotal: '0.00', total: '300.00', amountPaid: '0.00', balance: '300.00',
    billToName: 'Acme Dental', notes: 'INTERNAL-NOTE-DO-NOT-SHOW', termsAndConditions: null, sellerSnapshot: null, createdAt: '2026-03-01T00:00:00Z',
  },
  lines: [
    {
      id: 'hidden', invoiceId: 'inv-1', sourceType: 'bundle', parentLineId: null, catalogItemId: 'c2',
      name: null, description: 'Secret component', quantity: '1.00', unitPrice: '0.00', costBasis: '10.00', revenueAllocation: null,
      taxable: false, customerVisible: false, lineTotal: '0.00', isUnapprovedTime: false, sortOrder: 1, deviceCount: 0,
    },
  ],
};

function respondWith(dto: CustomerInvoiceDocument) {
  return { ok: true, status: 200, json: async () => ({ data: dto }), blob: async () => new Blob() };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('InvoiceDocumentPreview — renders the customer view', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue(respondWith(INVOICE_DTO_FIXTURES.issued));
  });

  it('renders the customer view, not the staff payload', async () => {
    render(<InvoiceDocumentPreview detail={detail} />);
    await waitFor(() => expect(screen.getByTestId('document-root')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledWith('/invoices/inv-1/customer-view');
    expect(screen.getByText('Remote support')).toBeInTheDocument();
    expect(screen.getByTestId('document-totals-hero')).toHaveTextContent('Balance due');
    expect(screen.queryByText('Secret component')).not.toBeInTheDocument();
    expect(screen.queryByText('INTERNAL-NOTE-DO-NOT-SHOW')).not.toBeInTheDocument();
    expect(screen.queryByText(/margin/i)).not.toBeInTheDocument();
  });

  it('refetches when the workspace reloads', async () => {
    const { rerender } = render(<InvoiceDocumentPreview detail={detail} />);
    await settle();
    rerender(<InvoiceDocumentPreview detail={{ ...detail }} />);
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('fetches on every mount of the Preview tab', async () => {
    const first = render(<InvoiceDocumentPreview detail={detail} />);
    await settle();
    first.unmount();
    render(<InvoiceDocumentPreview detail={detail} />);
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('discards a stale response', async () => {
    let resolveOld!: (v: unknown) => void;
    fetchWithAuth.mockReset();
    fetchWithAuth
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(respondWith({ ...INVOICE_DTO_FIXTURES.issued, invoice: { ...INVOICE_DTO_FIXTURES.issued.invoice, invoiceNumber: 'INV-NEW' } }));
    const { rerender } = render(<InvoiceDocumentPreview detail={detail} />);
    rerender(<InvoiceDocumentPreview detail={{ ...detail }} />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('INV-NEW'));
    await act(async () => { resolveOld(respondWith({ ...INVOICE_DTO_FIXTURES.issued, invoice: { ...INVOICE_DTO_FIXTURES.issued.invoice, invoiceNumber: 'INV-OLD' } })); });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('INV-NEW');
  });

  it('labels come from the document locale, not the staff UI language', async () => {
    await i18n.changeLanguage('pt-BR');
    try {
      render(<InvoiceDocumentPreview detail={detail} />);
      await waitFor(() => expect(screen.getByTestId('document-totals-hero')).toHaveTextContent('Balance due'));
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('sets the partner accent on the wrapper outside the document', async () => {
    render(<InvoiceDocumentPreview detail={detail} />);
    await waitFor(() => expect(screen.getByTestId('document-root')).toBeInTheDocument());
    const wrapper = screen.getByTestId('invoice-preview-paper');
    expect(wrapper.style.getPropertyValue('--doc-accent')).toBe('#1d4ed8');
    expect(wrapper.contains(screen.getByTestId('document-root'))).toBe(true);
  });

  it('shows an error line with retry when the fetch fails, and recovers', async () => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<InvoiceDocumentPreview detail={detail} />);
    const retry = await screen.findByTestId('invoice-preview-retry');
    fetchWithAuth.mockResolvedValueOnce(respondWith(INVOICE_DTO_FIXTURES.issued));
    retry.click();
    await waitFor(() => expect(screen.getByTestId('document-root')).toBeInTheDocument());
  });

  it('a blank bill-to does not fall back to the org name', async () => {
    fetchWithAuth.mockResolvedValue(respondWith({
      ...INVOICE_DTO_FIXTURES.issued,
      invoice: { ...INVOICE_DTO_FIXTURES.issued.invoice, billToName: null },
    }));
    const { unmount } = render(<InvoiceDocumentPreview detail={detail} />);
    await waitFor(() => expect(screen.getByTestId('document-root')).toBeInTheDocument());
    expect(screen.queryByText('Bill to')).not.toBeInTheDocument();
    // The org the invoice belongs to (staff `orgId`) never stands in for the customer.
    expect(screen.getByTestId('document-root')).not.toHaveTextContent('org-1');
    unmount();
    // Whitespace-only counts as blank; a real name renders (paired positive control).
    fetchWithAuth.mockResolvedValue(respondWith({
      ...INVOICE_DTO_FIXTURES.issued,
      invoice: { ...INVOICE_DTO_FIXTURES.issued.invoice, billToName: '   ' },
    }));
    const second = render(<InvoiceDocumentPreview detail={detail} />);
    await waitFor(() => expect(screen.getByTestId('document-root')).toBeInTheDocument());
    expect(screen.queryByText('Bill to')).not.toBeInTheDocument();
    second.unmount();
    fetchWithAuth.mockResolvedValue(respondWith(INVOICE_DTO_FIXTURES.issued));
    render(<InvoiceDocumentPreview detail={detail} />);
    await waitFor(() => expect(screen.getByText('Acme Dental')).toBeInTheDocument());
    expect(screen.getByText('Bill to')).toBeInTheDocument();
  });

  it('a payload that breaks the builder shows the error state, not a crash', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { invoice: {}, lines: [] } }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<InvoiceDocumentPreview detail={detail} />);
    expect(await screen.findByTestId('invoice-preview-error')).toBeInTheDocument();
  });

  it('keeps the PDF download affordance', async () => {
    render(<InvoiceDocumentPreview detail={detail} />);
    expect(screen.getByTestId('invoice-preview-download-pdf')).toBeInTheDocument();
  });
});
