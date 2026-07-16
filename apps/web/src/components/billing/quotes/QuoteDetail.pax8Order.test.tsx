import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

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
const ORDER_ID = 'bb0e43c8-1111-2222-3333-444455556666';

function convertedDetail(overrides: Partial<QuoteDetailData> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: ORG_ID, siteId: null, status: 'converted',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
      billToName: 'Acme Inc.', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: '2026-07-14T00:00:00Z', declinedAt: null, convertedAt: '2026-07-14T00:00:00Z',
      convertedInvoiceId: 'inv-1', sentAt: '2026-07-13T00:00:00Z', viewedAt: null,
      createdBy: null, createdAt: '2026-07-13T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
    },
    blocks: [],
    lines: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'read' }];
});

describe('QuoteDetail — staged Pax8 order', () => {
  it('renders the reload-derived staged-order summary and deep link for a converted quote', async () => {
    render(<QuoteDetail detail={convertedDetail({ pax8OrderId: ORDER_ID, pax8OrderLineCount: 3 })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const panel = screen.getByTestId('quote-staged-pax8-order');
    expect(panel).toHaveTextContent('This quote staged a Pax8 order (3 items) awaiting provisioning details');
    expect(screen.getByTestId('quote-staged-pax8-order-link')).toHaveAttribute(
      'href',
      `/settings/organizations/${ORG_ID}#pax8/${ORDER_ID}`,
    );
  });

  it('renders no staged-order panel when the persisted quote read model has no staged order', async () => {
    render(<QuoteDetail detail={convertedDetail({ pax8OrderId: null, pax8OrderLineCount: 0 })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-staged-pax8-order')).not.toBeInTheDocument();
  });

  it('does not surface a staged-order panel before the quote is converted', async () => {
    const detail = convertedDetail({ pax8OrderId: ORDER_ID, pax8OrderLineCount: 1 });
    render(<QuoteDetail detail={{ ...detail, quote: { ...detail.quote, status: 'accepted' } }} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-staged-pax8-order')).not.toBeInTheDocument();
  });
});
