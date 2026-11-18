import { render, screen, waitFor, within } from '@testing-library/react';
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

const MONTHLY = 'c1000000-0000-4000-8000-000000000001';
const ANNUAL = 'c1000000-0000-4000-8000-000000000002';

function convertedDetail(overrides: Partial<QuoteDetailData> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'converted',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '150.00',
      annualRecurringTotal: '1200.00', dueOnAcceptanceTotal: '0.00',
      billToName: 'Acme Inc.', introNotes: null, terms: null, termsAndConditions: null, sellerSnapshot: null,
      acceptedAt: '2026-07-14T00:00:00Z', declinedAt: null, convertedAt: '2026-07-14T00:00:00Z',
      convertedInvoiceId: null, sentAt: '2026-07-13T00:00:00Z', viewedAt: null,
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

describe('QuoteDetail — contracts created by the accept (#10361)', () => {
  it('links every generated contract and flags the drafts as waiting to be activated', async () => {
    render(<QuoteDetail detail={convertedDetail({
      contracts: [
        { id: MONTHLY, name: 'Q-1 — Monthly', status: 'draft', intervalMonths: 1 },
        { id: ANNUAL, name: 'Q-1 — Annual', status: 'active', intervalMonths: 12 },
      ],
    })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    const panel = screen.getByTestId('quote-generated-contracts');
    expect(panel).toHaveTextContent('This quote created 2 contracts');
    // One draft of two: the call to action names how many still need a human.
    expect(panel).toHaveTextContent('1 draft bills nothing until it is activated');

    expect(screen.getByTestId(`quote-generated-contract-link-${MONTHLY}`)).toHaveAttribute('href', `/contracts/${MONTHLY}`);
    expect(screen.getByTestId(`quote-generated-contract-link-${ANNUAL}`)).toHaveAttribute('href', `/contracts/${ANNUAL}`);
    const draftRow = screen.getByTestId(`quote-generated-contract-${MONTHLY}`);
    expect(within(draftRow).getByTestId(`quote-generated-contract-ready-${MONTHLY}`)).toHaveTextContent('Ready to activate');
    const activeRow = screen.getByTestId(`quote-generated-contract-${ANNUAL}`);
    expect(within(activeRow).queryByTestId(`quote-generated-contract-ready-${ANNUAL}`)).not.toBeInTheDocument();
    expect(activeRow).toHaveTextContent('Active');
  });

  it('drops the activate call to action once every contract is live', async () => {
    render(<QuoteDetail detail={convertedDetail({
      contracts: [{ id: ANNUAL, name: 'Q-1 — Annual', status: 'active', intervalMonths: 12 }],
    })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    const panel = screen.getByTestId('quote-generated-contracts');
    expect(panel).toHaveTextContent('This quote created 1 contract');
    expect(panel).not.toHaveTextContent('until');
  });

  it('says the list could not load instead of implying no contract exists', async () => {
    render(<QuoteDetail detail={convertedDetail({ contracts: null, contractsUnavailable: true })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-generated-contracts-unavailable'))
      .toHaveTextContent("Couldn't load the contracts this quote created. Reload to try again.");
    expect(screen.queryByTestId('quote-generated-contracts')).not.toBeInTheDocument();
  });

  it('renders nothing when the accept created no contract, or the viewer cannot read contracts', async () => {
    const { unmount } = render(<QuoteDetail detail={convertedDetail({ contracts: [] })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-generated-contracts')).not.toBeInTheDocument();
    unmount();

    render(<QuoteDetail detail={convertedDetail({ contracts: null })} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-generated-contracts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-generated-contracts-unavailable')).not.toBeInTheDocument();
  });
});
