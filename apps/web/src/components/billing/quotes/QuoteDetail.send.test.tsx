import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import * as quotesApi from '../../../lib/api/quotes';
import type { QuoteDetail as QuoteDetailData, QuoteLine } from './quoteTypes';

// Same auth-mock pattern as QuoteDetail.delete.test.tsx.
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
  return { ...actual, sendQuote: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const line: QuoteLine = {
  id: 'l-1', quoteId: 'q-1', blockId: null, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, name: null, description: 'Onboarding', quantity: '1',
  unitPrice: '500.00', taxable: false, customerVisible: true, lineTotal: '500.00',
  recurrence: 'one_time', termMonths: null, billingFrequency: null, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
};

const emptyDraft: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
    currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
    taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: 'Acme', introNotes: null,
    terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

const filledDraft: QuoteDetailData = {
  ...emptyDraft,
  quote: { ...emptyDraft.quote, oneTimeTotal: '500.00', dueOnAcceptanceTotal: '500.00', subtotal: '500.00', total: '500.00' },
  lines: [line],
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'send' }];
});

describe('QuoteDetail — send proposal', () => {
  it('disables Send and shows a hint when the quote has no content', async () => {
    render(<QuoteDetail detail={emptyDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.getByTestId('quote-send')).toBeDisabled();
    expect(screen.getByTestId('quote-send-empty-hint')).toBeInTheDocument();
  });

  it('does not send on the first click — it opens a confirm step first', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());
    // Critical: the irreversible email must NOT have fired from the first click.
    expect(sendQuote).not.toHaveBeenCalled();
  });

  it('sends only after the confirm step and refreshes the quote', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    sendQuote.mockResolvedValue(resp({ data: null }));
    const onChanged = vi.fn();

    render(<QuoteDetail detail={filledDraft} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() => {
      expect(sendQuote).toHaveBeenCalledWith('q-1');
      expect(onChanged).toHaveBeenCalled();
    });
  });
});
