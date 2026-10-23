import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import QuoteDetail from './QuoteDetail';
import type { QuoteDetail as QuoteDetailData, QuoteLine } from './quoteTypes';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: 'quotes', action: 'read' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const DESCRIPTION = 'Includes:\n• Dell R360\n• Windows Server 2025';

function line(over: Partial<QuoteLine>): QuoteLine {
  return {
    id: 'l-1', quoteId: 'q-1', blockId: null, orgId: 'org-1', sourceType: 'manual',
    catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
    name: 'Server build', description: DESCRIPTION, quantity: '1.00', unitPrice: '10.00',
    taxable: false, customerVisible: true, lineTotal: '10.00', recurrence: 'one_time',
    termMonths: null, billingFrequency: null, sortOrder: 0, createdAt: '', ...over,
  };
}

const detail = (lines: QuoteLine[]): QuoteDetailData => ({
  quote: {
    id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '10.00', taxRate: null,
    taxTotal: '0.00', total: '10.00', oneTimeTotal: '10.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '10.00',
    billToName: 'Acme', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null,
    declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null,
    viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines,
});

describe('QuoteDetail line description (#9423)', () => {
  it('keeps newlines in the blurb and shows the title', async () => {
    render(<QuoteDetail detail={detail([line({})])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    const blurb = screen.getByTestId('document-line-blurb-l-1');
    expect(blurb.className).toContain('whitespace-pre-line');
    expect(blurb.textContent).toBe(DESCRIPTION);
    expect(screen.getByTestId('quote-detail-line-l-1').textContent).toContain('Server build');
  });

  it('legacy unnamed line: description is the title, no blurb', async () => {
    render(<QuoteDetail detail={detail([line({ name: null, description: 'Legacy thing' })])} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-detail-line-l-1').textContent).toContain('Legacy thing');
    expect(screen.queryByTestId('document-line-blurb-l-1')).toBeNull();
  });
});
