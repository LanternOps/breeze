import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QuoteDocument } from './QuoteDocument';
import QuoteDocumentPreview from './QuoteDocument';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { fetchWithAuth } from '../../../stores/auth';

// QuoteDocument is presentational, but its module imports the auth/org stores and
// navigation (used by the preview wrapper + authed images). Mock them so the unit
// renders without real store initialization or network.
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: { id: string; name: string }[] }) => unknown) =>
    selector({ organizations: [{ id: 'org-1', name: 'Acme Industries' }] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

function makeDetail(overrides: Partial<QuoteDetailData> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1042', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'sent',
      currencyCode: 'USD', issueDate: '2026-06-01', expiryDate: '2026-07-01', subtotal: '500.00', taxRate: null,
      taxTotal: '0.00', total: '545.00', oneTimeTotal: '500.00', monthlyRecurringTotal: '45.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '500.00', billToName: 'Acme Industries',
      introNotes: 'Thanks for considering us.', terms: null, termsAndConditions: 'Net 30.',
      sellerSnapshot: null, acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null,
      sentAt: '2026-06-01T00:00:00Z', viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [
      { id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: { label: 'Services' }, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
    ],
    lines: [
      { id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: null, name: null, description: 'Managed Workstation', quantity: '10', unitPrice: '45.00', unitCost: null, sku: null, partNumber: null, taxable: false, customerVisible: true, lineTotal: '450.00', recurrence: 'monthly', termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'l-2', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: null, name: null, description: 'Onboarding', quantity: '1', unitPrice: '500.00', unitCost: null, sku: null, partNumber: null, taxable: false, customerVisible: true, lineTotal: '500.00', recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z' },
    ],
    branding: {
      partnerName: 'Lantern IT', logoUrl: null, primaryColor: '#1c8a9e', footer: 'Thank you for your business.',
      currencyCode: 'USD', seller: { name: 'Lantern IT', address: null, phone: null, email: 'hi@lantern.it', website: null },
    },
    ...overrides,
  };
}

describe('QuoteDocument', () => {
  it('renders the proposal inline (no PDF iframe) with number, customer, lines and due total', () => {
    render(<QuoteDocument detail={makeDetail()} customerName="Acme Industries" />);

    // Regression guard: the preview is inline HTML, never a downloaded/embedded PDF.
    expect(document.querySelector('iframe')).toBeNull();

    expect(screen.getByTestId('quote-document-number')).toHaveTextContent('Q-1042');
    expect(screen.getByTestId('quote-document-customer')).toHaveTextContent('Acme Industries');
    expect(screen.getByText('Managed Workstation')).toBeInTheDocument();
    expect(screen.getByTestId('quote-document-due')).toHaveTextContent('$500.00');
    // Recurring summary surfaces the monthly figure.
    expect(screen.getByText(/Monthly recurring/i)).toBeInTheDocument();
    // Seller "From" block + footer render.
    expect(screen.getByText('hi@lantern.it')).toBeInTheDocument();
    expect(screen.getByText('Thank you for your business.')).toBeInTheDocument();
  });

  it('shows an empty state when the proposal has no content', () => {
    render(<QuoteDocument detail={makeDetail({ blocks: [], lines: [] })} customerName="Acme Industries" />);
    expect(screen.getByText(/doesn’t have any content yet/i)).toBeInTheDocument();
    // No totals block without content.
    expect(screen.queryByTestId('quote-document-due')).toBeNull();
  });

  it('falls back to a draft label and partner wordmark when number/logo are absent', () => {
    const d = makeDetail();
    d.quote.quoteNumber = null;
    render(<QuoteDocument detail={d} customerName="Acme Industries" />);
    expect(screen.getByTestId('quote-document-number')).toHaveTextContent('Draft');
    expect(screen.getByTestId('quote-document-wordmark')).toHaveTextContent('Lantern IT'); // no logoUrl → wordmark
  });

  it('renders the resolved customer billing address and tax id in the Prepared for block', () => {
    const detail = makeDetail({
      billTo: {
        name: 'Animal Health at Home',
        address: { line1: '123 Vet Way', line2: 'Suite 4', city: 'Berthoud', region: 'CO', postalCode: '80513', country: 'US' },
        taxId: '84-1234567',
      },
    });
    render(<QuoteDocument detail={detail} customerName="Animal Health at Home" />);
    const addr = screen.getByTestId('quote-document-billto-address');
    expect(addr).toHaveTextContent('123 Vet Way');
    expect(addr).toHaveTextContent('Berthoud, CO, 80513');
    expect(screen.getByTestId('quote-document-billto-taxid')).toHaveTextContent('84-1234567');
  });

  it('omits the address block when the org has saved no billing address', () => {
    const detail = makeDetail({ billTo: { name: 'Acme', address: null, taxId: null } });
    render(<QuoteDocument detail={detail} customerName="Acme" />);
    expect(screen.queryByTestId('quote-document-billto-address')).toBeNull();
    expect(screen.queryByTestId('quote-document-billto-taxid')).toBeNull();
  });

  it('shows a per-table subtotal row only when the block opts in', () => {
    // Default block has no showSubtotal → no subtotal row.
    render(<QuoteDocument detail={makeDetail()} customerName="Acme" />);
    expect(screen.queryByTestId('quote-table-subtotal')).toBeNull();
  });

  it('renders the opt-in subtotal split by recurrence', () => {
    const d = makeDetail();
    d.blocks[0].content = { label: 'Services', showSubtotal: true };
    render(<QuoteDocument detail={d} customerName="Acme" />);
    const row = screen.getByTestId('quote-table-subtotal');
    // Fixture: $500 one-time + $450/mo.
    expect(row).toHaveTextContent('$500.00');
    expect(row.textContent).toMatch(/\$450\.00/);
  });

  it('renders a rich_text block as formatted HTML (not stripped to plain text)', () => {
    const d = makeDetail();
    d.blocks = [
      ...d.blocks,
      {
        id: 'b-2', quoteId: 'q-1', orgId: 'org-1', blockType: 'rich_text',
        content: { html: '<p>Please review <strong>carefully</strong>.</p><ul><li>Item one</li></ul>' },
        sortOrder: 1, createdAt: '2026-06-01T00:00:00Z',
      },
    ];
    render(<QuoteDocument detail={d} customerName="Acme" />);

    // Real elements, not escaped/stripped text — the API is trusted to have
    // already sanitized this HTML (richTextSanitize.ts), so it's rendered as-is.
    const strongEl = screen.getByText('carefully');
    expect(strongEl.tagName).toBe('STRONG');
    const listItem = screen.getByText('Item one');
    expect(listItem.closest('li')).not.toBeNull();
  });

  it('renders an authored contract block via dangerouslySetInnerHTML with a template name + version footer', () => {
    const d = makeDetail();
    d.blocks = [
      ...d.blocks,
      {
        id: 'b-3', quoteId: 'q-1', orgId: 'org-1', blockType: 'contract',
        content: {
          label: 'Master Services Agreement',
          templateName: 'MSA',
          versionNumber: 3,
          sourceType: 'authored',
          renderedHtml: '<p>Acme Industries agrees to Texas law.</p>',
          fileUrl: null,
        },
        sortOrder: 2, createdAt: '2026-06-01T00:00:00Z',
      },
    ];
    render(<QuoteDocument detail={d} customerName="Acme Industries" />);

    const el = screen.getByTestId('contract-block');
    expect(el.textContent).toContain('Acme Industries agrees to Texas law.');
    expect(el.textContent).toContain('Master Services Agreement');
    expect(el.textContent).toContain('MSA');
    expect(el.textContent).toContain('3');
    expect(el.innerHTML).not.toContain('{{');
    expect(el.querySelector('iframe')).toBeNull();
  });

  it('renders an uploaded contract block as an authed-fetched iframe + download link', async () => {
    const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, status: 200, blob: vi.fn().mockResolvedValue(blob) } as unknown as Response);
    vi.stubGlobal('URL', { createObjectURL: vi.fn().mockReturnValue('blob:mock-contract'), revokeObjectURL: vi.fn() });

    const d = makeDetail();
    d.blocks = [
      ...d.blocks,
      {
        id: 'b-4', quoteId: 'q-1', orgId: 'org-1', blockType: 'contract',
        content: {
          templateName: 'Vendor MSA (uploaded)',
          versionNumber: 1,
          sourceType: 'uploaded',
          renderedHtml: null,
          fileUrl: '/quotes/q-1/contract-file/b-4',
        },
        sortOrder: 2, createdAt: '2026-06-01T00:00:00Z',
      },
    ];
    render(<QuoteDocument detail={d} customerName="Acme Industries" />);

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('blob:mock-contract');
    expect(fetchWithAuth).toHaveBeenCalledWith('/quotes/q-1/contract-file/b-4');
    expect(screen.getByTestId('quote-contract-download')).toHaveAttribute('href', 'blob:mock-contract');

    vi.unstubAllGlobals();
  });

  it('shows an unavailable fallback for an uploaded contract block with no fileUrl (no iframe fetch attempted)', () => {
    const d = makeDetail();
    d.blocks = [
      ...d.blocks,
      {
        id: 'b-5', quoteId: 'q-1', orgId: 'org-1', blockType: 'contract',
        content: { templateName: 'MSA', versionNumber: 1, sourceType: 'uploaded', renderedHtml: null, fileUrl: null },
        sortOrder: 2, createdAt: '2026-06-01T00:00:00Z',
      },
    ];
    render(<QuoteDocument detail={d} customerName="Acme Industries" />);
    expect(screen.getByTestId('contract-block')).toHaveTextContent('Contract file unavailable');
    expect(document.querySelector('iframe')).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('never renders internal cost/markup/net on the customer document', () => {
    const detail = makeDetail({
      lines: [
        {
          id: 'l-3',
          quoteId: 'q-1',
          blockId: 'b-1',
          orgId: 'org-1',
          sourceType: 'manual',
          catalogItemId: null,
          parentLineId: null,
          unitCost: '100.00',
          sku: 'SKU-1',
          partNumber: 'PN-001',
          name: null,
          description: 'Test Product',
          quantity: '1',
          unitPrice: '130.00',
          taxable: false,
          customerVisible: true,
          lineTotal: '130.00',
          recurrence: 'one_time',
          termMonths: null,
          billingFrequency: null,
          sortOrder: 0,
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
    });
    const { container } = render(<QuoteDocument detail={detail} customerName="Acme" />);
    expect(container.textContent).not.toMatch(/markup/i);
    expect(container.textContent).not.toContain('100.00'); // the cost value
  });
});

describe('QuoteDocumentPreview', () => {
  it('renders the customer document with a Download PDF action and resolves the org name', () => {
    const d = makeDetail();
    d.quote.billToName = null; // force org-list resolution
    render(<QuoteDocumentPreview detail={d} />);
    expect(screen.getByTestId('quote-preview')).toBeInTheDocument();
    expect(screen.getByTestId('quote-preview-download-pdf')).toBeInTheDocument();
    expect(screen.getByTestId('quote-document-customer')).toHaveTextContent('Acme Industries');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('falls back to an em-dash (never a raw org UUID fragment) when neither billToName nor the org store resolves', () => {
    const d = makeDetail();
    d.quote.billToName = null; // no explicit bill-to
    d.quote.orgId = '9f8e7d6c-1234-4abc-9def-0123456789ab'; // not in the mocked org store
    render(<QuoteDocumentPreview detail={d} />);
    const customer = screen.getByTestId('quote-document-customer');
    expect(customer).toHaveTextContent('—');
    // The UUID (or its first 8 chars) must never leak onto the customer document.
    expect(customer).not.toHaveTextContent('9f8e7d6c');
  });
});
