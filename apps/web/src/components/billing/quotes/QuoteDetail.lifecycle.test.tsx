import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import { type QuoteDetail as QuoteDetailData, formatDate } from './quoteTypes';
import { useOrgStore } from '../../../stores/orgStore';

// A quote's most valuable moment — the customer accepted, or the proposal was
// converted to an invoice — used to render as nothing but a status pill. This
// covers the compact lifecycle strip (Sent · Viewed · Accepted / Declined) and
// the converted-invoice link in the Detail summary card.
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

const ORG_ID = 'aa0e43c8-1111-2222-3333-444455556666';

function detailWith(overrides: Partial<QuoteDetailData['quote']>): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: ORG_ID, siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
      billToName: 'Acme Inc.', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: null, declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null,
      viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
      ...overrides,
    },
    blocks: [],
    lines: [],
  };
}

const initialOrgState = useOrgStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'read' }];
  useOrgStore.setState({ organizations: [] });
});

afterEach(() => {
  useOrgStore.setState(initialOrgState, true);
});

describe('QuoteDetail — lifecycle strip', () => {
  it('renders Accepted with the formatted date on an accepted quote', async () => {
    render(<QuoteDetail detail={detailWith({
      status: 'accepted', sentAt: '2026-06-02T00:00:00Z', viewedAt: '2026-06-03T00:00:00Z',
      acceptedAt: '2026-06-04T00:00:00Z',
    })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const strip = screen.getByTestId('quote-detail-lifecycle');
    expect(strip).toHaveTextContent('Sent');
    expect(strip).toHaveTextContent('Viewed');
    expect(strip).toHaveTextContent('Accepted');
    expect(strip).toHaveTextContent(formatDate('2026-06-04T00:00:00Z'));
    // A quote that was accepted was never declined — no danger stage.
    expect(strip).not.toHaveTextContent('Declined');
  });

  it('renders only the non-null stages (sent, no view/accept yet)', async () => {
    render(<QuoteDetail detail={detailWith({ status: 'sent', sentAt: '2026-06-02T00:00:00Z' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const strip = screen.getByTestId('quote-detail-lifecycle');
    expect(strip).toHaveTextContent('Sent');
    expect(strip).not.toHaveTextContent('Viewed');
    expect(strip).not.toHaveTextContent('Accepted');
  });

  it('shows Declined in the destructive token when declined', async () => {
    render(<QuoteDetail detail={detailWith({
      status: 'declined', sentAt: '2026-06-02T00:00:00Z', declinedAt: '2026-06-05T00:00:00Z',
    })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const declined = screen.getByTestId('quote-detail-lifecycle-declined');
    expect(declined).toHaveTextContent('Declined');
    expect(declined.className).toContain('text-destructive');
  });

  it('renders no lifecycle strip on a plain draft (nothing to show)', async () => {
    render(<QuoteDetail detail={detailWith({ status: 'draft' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-detail-lifecycle')).not.toBeInTheDocument();
  });
});

describe('QuoteDetail — converted-invoice link', () => {
  it('links to the converted invoice with the correct href', async () => {
    render(<QuoteDetail detail={detailWith({
      status: 'converted', sentAt: '2026-06-02T00:00:00Z', acceptedAt: '2026-06-04T00:00:00Z',
      convertedAt: '2026-06-06T00:00:00Z', convertedInvoiceId: 'inv-99',
    })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const link = screen.getByTestId('quote-view-invoice');
    expect(link).toHaveAttribute('href', '/billing/invoices/inv-99');
    expect(link).toHaveTextContent('View invoice');
  });

  it('renders no invoice link when the quote has not been converted', async () => {
    render(<QuoteDetail detail={detailWith({ status: 'accepted', acceptedAt: '2026-06-04T00:00:00Z' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-view-invoice')).not.toBeInTheDocument();
  });
});
