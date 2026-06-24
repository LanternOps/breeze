import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QuoteDocument } from './QuoteDocument';
import QuoteDocumentPreview from './QuoteDocument';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

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
      { id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: null, description: 'Managed Workstation', quantity: '10', unitPrice: '45.00', taxable: false, customerVisible: true, lineTotal: '450.00', recurrence: 'monthly', termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'l-2', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual', catalogItemId: null, parentLineId: null, description: 'Onboarding', quantity: '1', unitPrice: '500.00', taxable: false, customerVisible: true, lineTotal: '500.00', recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 1, createdAt: '2026-06-01T00:00:00Z' },
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
});
