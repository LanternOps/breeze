import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import { type QuoteDetail as QuoteDetailData } from './quoteTypes';
import { useOrgStore } from '../../../stores/orgStore';

// Regression for #1712: the Customer row used to render `quote.orgId.slice(0,8)`
// (the raw UUID prefix) whenever `billToName` was null — making the proposal
// header look unfinished. The fix resolves the real organization name from the
// client-side org list (the same source the org switcher uses), with the UUID
// prefix kept only as a last resort.
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

function detailWith(billToName: string | null): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: ORG_ID, siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00',
      billToName, introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null,
      declinedAt: null, convertedAt: null, convertedInvoiceId: null, sentAt: null,
      viewedAt: null, createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
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

describe('QuoteDetail — Customer label', () => {
  it('prefers the explicit billToName when present', async () => {
    useOrgStore.setState({
      organizations: [{ id: ORG_ID, partnerId: 'p-1', name: 'Default Organization', status: 'active', createdAt: '' }],
    });
    render(<QuoteDetail detail={detailWith('Acme Inc.')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-detail-customer')).toHaveTextContent('Acme Inc.');
  });

  it('resolves the org name from the store when billToName is null (not the UUID prefix)', async () => {
    useOrgStore.setState({
      organizations: [{ id: ORG_ID, partnerId: 'p-1', name: 'Default Organization', status: 'active', createdAt: '' }],
    });
    render(<QuoteDetail detail={detailWith(null)} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const customer = screen.getByTestId('quote-detail-customer');
    expect(customer).toHaveTextContent('Default Organization');
    // The raw UUID prefix must NOT leak into the header.
    expect(customer).not.toHaveTextContent(ORG_ID.slice(0, 8));
  });

  it('falls back to the UUID prefix only when no name resolves', async () => {
    // Org not in the loaded list (e.g. All-orgs scope) and no billToName.
    render(<QuoteDetail detail={detailWith(null)} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-detail-customer')).toHaveTextContent(ORG_ID.slice(0, 8));
  });
});
