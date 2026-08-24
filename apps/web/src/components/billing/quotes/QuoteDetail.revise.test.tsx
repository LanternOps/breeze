import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { useOrgStore } from '../../../stores/orgStore';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));
const mocks = vi.hoisted(() => ({ reviseQuote: vi.fn(), cloneQuote: vi.fn(), runAction: vi.fn(), navigateTo: vi.fn() }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: mocks.navigateTo }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../lib/api/quotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api/quotes')>();
  return { ...actual, reviseQuote: mocks.reviseQuote, cloneQuote: mocks.cloneQuote };
});
vi.mock('../../../lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/runAction')>();
  return { ...actual, runAction: mocks.runAction, handleActionError: vi.fn() };
});

const ORG_ID = 'aa0e43c8-1111-2222-3333-444455556666';

function detailWith(
  overrides: Partial<QuoteDetailData['quote']>,
  detailOverrides: Partial<QuoteDetailData> = {},
): QuoteDetailData {
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
    ...detailOverrides,
  };
}

const initialOrgState = useOrgStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'read' }, { resource: 'quotes', action: 'write' }];
  useOrgStore.setState({ organizations: [] });
  mocks.runAction.mockImplementation(async ({ request }: { request: () => Promise<unknown> }) => {
    await request();
    return { data: { id: 'q-new' } };
  });
  mocks.reviseQuote.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'q-new' } }), { status: 200 }));
});

afterEach(() => { useOrgStore.setState(initialOrgState, true); });

describe('QuoteDetail — declined banner Revise', () => {
  // Regression: this button used to CLONE, producing an unlinked quote and
  // leaving the declined original live. "Revise" must mean the same thing here
  // as it does in the actions menu — a linked revision.
  it('creates a LINKED revision, not a clone', async () => {
    render(<QuoteDetail detail={detailWith({ status: 'declined', declinedAt: '2026-06-05T00:00:00Z' })} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByTestId('quote-declined-revise'));

    await waitFor(() => expect(mocks.reviseQuote).toHaveBeenCalledWith('q-1'));
    expect(mocks.cloneQuote).not.toHaveBeenCalled();
    expect(mocks.navigateTo).toHaveBeenCalledWith('/billing/quotes/q-new');
  });
});

describe('QuoteDetail — lineage banner', () => {
  it('points a superseded quote at its replacement', async () => {
    render(<QuoteDetail
      detail={detailWith({ status: 'superseded' }, { successor: { id: 'q-2', quoteNumber: 'Q-2', status: 'sent' } })}
      onChanged={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.getByTestId('quote-lineage-superseded')).toBeInTheDocument();
    expect(screen.getByTestId('quote-lineage-successor-link')).toHaveAttribute('href', '/billing/quotes/q-2');
    expect(screen.getByTestId('quote-lineage-successor-link')).toHaveTextContent('Q-2');
  });

  it('warns on a live quote that a revision is being drafted against it', async () => {
    render(<QuoteDetail
      detail={detailWith({ status: 'sent' }, { successor: { id: 'q-2', quoteNumber: 'Q-2', status: 'draft' } })}
      onChanged={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    // The warning matters: sending that draft retires THIS quote and kills the
    // link the customer is currently holding.
    expect(screen.getByTestId('quote-lineage-in-progress')).toBeInTheDocument();
    expect(screen.getByTestId('quote-lineage-draft-link')).toHaveAttribute('href', '/billing/quotes/q-2');
    expect(screen.queryByTestId('quote-lineage-superseded')).not.toBeInTheDocument();
  });

  it('shows the parent on a revision', async () => {
    render(<QuoteDetail
      detail={detailWith({ status: 'draft', revisionOfQuoteId: 'q-0', revisionNumber: 2 },
        { revisionOf: { id: 'q-0', quoteNumber: 'Q-0', recipients: ['a@b.test'] } })}
      onChanged={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.getByTestId('quote-lineage-parent-link')).toHaveAttribute('href', '/billing/quotes/q-0');
    expect(screen.getByTestId('quote-lineage-parent-link')).toHaveTextContent('Q-0');
  });

  it('renders nothing for a quote with no lineage', async () => {
    render(<QuoteDetail detail={detailWith({ status: 'sent' })} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-lineage-banner')).not.toBeInTheDocument();
  });

  // A superseded quote's successor is the replacement, never an "in progress"
  // warning — the two branches must not both fire.
  it('does not show the in-progress warning on an already-superseded quote', async () => {
    render(<QuoteDetail
      detail={detailWith({ status: 'superseded' }, { successor: { id: 'q-2', quoteNumber: 'Q-2', status: 'draft' } })}
      onChanged={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-lineage-in-progress')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-lineage-superseded')).toBeInTheDocument();
  });
});
