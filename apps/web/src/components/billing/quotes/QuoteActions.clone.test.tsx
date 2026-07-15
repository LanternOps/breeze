import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  cloneQuote: vi.fn(),
  navigateTo: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: mocks.can }) }));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: mocks.navigateTo }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../lib/api/quotes', () => ({
  cloneQuote: mocks.cloneQuote,
  sendQuote: vi.fn(),
  deleteQuote: vi.fn(),
  quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf'),
}));
vi.mock('../../../lib/runAction', () => ({
  runAction: mocks.runAction,
  handleActionError: vi.fn(),
}));
vi.mock('../../shared/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const detail: QuoteDetailData = {
  quote: {
    id: 'q-1', quoteNumber: 'Q-2026-000001', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'accepted',
    currencyCode: 'USD', issueDate: '2026-06-01', expiryDate: null, subtotal: '100.00', taxRate: null,
    taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '100.00', billToName: null, introNotes: null,
    terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: '2026-06-02', declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: '2026-06-01', viewedAt: '2026-06-01',
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z',
  },
  blocks: [],
  lines: [],
};

describe('QuoteActions cloning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockImplementation((_resource: string, action: string) => action === 'read' || action === 'write');
    mocks.runAction.mockImplementation(async ({ request }: { request: () => Promise<unknown> }) => {
      await request();
      return { data: { id: 'q-2' } };
    });
    mocks.cloneQuote.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'q-2' } }), { status: 200 }));
  });

  it('clones any readable quote with write permission and opens the new draft', async () => {
    render(<QuoteActions detail={detail} variant="header" />);

    fireEvent.click(screen.getByTestId('quote-clone'));

    await waitFor(() => expect(mocks.cloneQuote).toHaveBeenCalledWith('q-1'));
    expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({
      successMessage: 'Quote cloned.',
      errorFallback: 'Could not clone the quote.',
    }));
    expect(mocks.navigateTo).toHaveBeenCalledWith('/billing/quotes/q-2');
  });

  it('does not offer cloning to a read-only user', () => {
    mocks.can.mockImplementation((_resource: string, action: string) => action === 'read');

    render(<QuoteActions detail={detail} variant="header" />);

    expect(screen.queryByTestId('quote-clone')).not.toBeInTheDocument();
  });

  it('holds cloning while draft changes are still saving', () => {
    render(<QuoteActions detail={{ ...detail, quote: { ...detail.quote, status: 'draft' } }} variant="header" savePending />);

    expect(screen.getByTestId('quote-clone')).toBeDisabled();
    expect(screen.getByTestId('quote-clone')).toHaveAttribute(
      'title',
      'Wait for changes to finish saving before cloning.',
    );
  });
});
