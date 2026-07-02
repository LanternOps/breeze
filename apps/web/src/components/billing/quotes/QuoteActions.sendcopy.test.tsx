import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// The post-send success toast should tell the seller "what happens next" — that
// the proposal will move to Viewed and Accepted on its own as the customer opens
// and signs — instead of a bare "Proposal sent". This asserts the copy (and the
// customer name interpolation) via the successMessage passed to runAction.
const runAction = vi.hoisted(() => vi.fn(async (opts: { request: () => Promise<unknown> }) => { await opts.request(); }));
vi.mock('../../../lib/runAction', () => ({ runAction, handleActionError: vi.fn() }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../lib/api/quotes', () => ({ sendQuote: vi.fn().mockResolvedValue({}), deleteQuote: vi.fn(), quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf') }));
// A clickable ConfirmDialog stand-in so we can drive the confirm path.
vi.mock('../../shared/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm, confirmTestId }: { open: boolean; onConfirm: () => void; confirmTestId?: string }) =>
    open ? <button type="button" data-testid={confirmTestId} onClick={onConfirm}>confirm</button> : null,
}));

function draft(extra: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: 'Acme Inc.', introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...extra,
    },
    blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    lines: [],
  };
}

beforeEach(() => vi.clearAllMocks());

describe('QuoteActions — post-send success copy', () => {
  it('the success toast advertises the auto Viewed/Accepted lifecycle with the customer name', async () => {
    render(<QuoteActions detail={draft()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    fireEvent.click(await screen.findByTestId('quote-send-confirm'));

    await waitFor(() => expect(runAction).toHaveBeenCalled());
    const opts = runAction.mock.calls[0]![0] as { successMessage?: string };
    expect(opts.successMessage).toBe(
      "Proposal sent — we'll mark it Viewed and Accepted as Acme Inc. opens and signs.",
    );
  });
});
