import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import * as quotesApi from '../../../lib/api/quotes';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// Full set of auth mock (same pattern as QuoteDetail.permissions.test.tsx)
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

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

vi.mock('../../../lib/api/quotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api/quotes')>();
  return { ...actual, deleteQuote: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const draftDetail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
    taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', billToName: 'Acme', introNotes: null, terms: null,
    termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

const sentDetail: QuoteDetailData = {
  ...draftDetail,
  quote: { ...draftDetail.quote, status: 'sent', sentAt: '2026-06-02T00:00:00Z' },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'write' }];
});

describe('QuoteDetail — delete action', () => {
  it('shows the Delete draft button for a draft quote when the user has quotes:write', async () => {
    render(<QuoteDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-delete-open')).toBeInTheDocument();
  });

  it('hides the Delete draft button on a non-draft quote', async () => {
    render(<QuoteDetail detail={sentDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-delete-open')).not.toBeInTheDocument();
  });

  it('hides the Delete draft button when the user lacks quotes:write', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    render(<QuoteDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-delete-open')).not.toBeInTheDocument();
  });

  it('deletes a draft quote and navigates to the list', async () => {
    const deleteQuote = vi.mocked(quotesApi.deleteQuote);
    deleteQuote.mockResolvedValue(resp({ data: null }));

    const { navigateTo } = await import('@/lib/navigation');
    const navigateMock = vi.mocked(navigateTo);

    render(<QuoteDetail detail={draftDetail} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-delete-open'));
    // ConfirmDialog should now be open
    await waitFor(() => expect(screen.getByTestId('quote-delete-confirm')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-delete-confirm'));
    await waitFor(() => {
      expect(deleteQuote).toHaveBeenCalledWith('q-1');
      expect(navigateMock).toHaveBeenCalledWith('/billing/quotes');
    });
  });
});
