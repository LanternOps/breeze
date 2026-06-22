import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import { formatMoney, type QuoteDetail as QuoteDetailData } from './quoteTypes';

// Regression for the "First-invoice total" mislabel: accept auto-issues a
// ONE-TIME-only invoice, so the prominent figure must advertise what is invoiced
// on accept (dueOnAcceptanceTotal == one-time + one-time tax), NOT the
// recurring-inclusive `total`. The recurring-inclusive number is shown separately
// as "First-period total (incl. recurring)".
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [{ resource: 'quotes', action: 'read' }] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

// A quote mixing a $500 one-time line with recurring revenue: total = 1950 (first
// period of each cadence), but only $500 is invoiced on accept.
const mixedDetail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '1950.00', taxRate: null,
    taxTotal: '0.00', total: '1950.00', oneTimeTotal: '500.00', monthlyRecurringTotal: '1000.00',
    annualRecurringTotal: '450.00', dueOnAcceptanceTotal: '500.00',
    billToName: 'Acme', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null,
    declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null,
    viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'read' }];
});

describe('QuoteDetail — totals labelling', () => {
  it('prominent figure is the due-on-acceptance amount (one-time), NOT the recurring-inclusive total', async () => {
    render(<QuoteDetail detail={mixedDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const due = screen.getByTestId('quote-detail-due-on-acceptance');
    expect(due).toHaveTextContent(formatMoney('500.00', 'USD'));
    // It must equal the one-time total, never the recurring-inclusive total.
    expect(due).toHaveTextContent(formatMoney(mixedDetail.quote.oneTimeTotal, 'USD'));
    expect(due).not.toHaveTextContent(formatMoney(mixedDetail.quote.total, 'USD'));

    // The recurring-inclusive total is still shown, but labelled as first-period.
    const firstPeriod = screen.getByTestId('quote-detail-first-period');
    expect(firstPeriod).toHaveTextContent(formatMoney('1950.00', 'USD'));

    // The misleading "First-invoice total" testid is gone.
    expect(screen.queryByTestId('quote-detail-total')).not.toBeInTheDocument();
  });

  it('falls back to oneTimeTotal when the derived dueOnAcceptanceTotal is absent', async () => {
    const noDerived: QuoteDetailData = {
      ...mixedDetail,
      quote: { ...mixedDetail.quote, dueOnAcceptanceTotal: undefined },
    };
    render(<QuoteDetail detail={noDerived} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-detail-due-on-acceptance')).toHaveTextContent(formatMoney('500.00', 'USD'));
  });
});
