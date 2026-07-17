import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// The post-send success toast should tell the seller "what happens next" — that
// the proposal will move to Viewed and Accepted on its own as the customer opens
// and signs — instead of a bare "Proposal sent". Since the emailed=false warning
// branch, the success copy goes through showToast (not runAction's successMessage).
const runAction = vi.hoisted(() => vi.fn(async (opts: { request: () => Promise<unknown> }) => opts.request()));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/runAction', () => ({ runAction, handleActionError: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// fetchWithAuth serves the composer's billing-contact prefill (Send stays
// disabled until To is valid); tokens: null keeps the composer org-scoped so
// the partner-only signature/Stripe fetches are skipped.
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () =>
    ({ ok: true, json: async () => ({ billingContact: { email: 'ap@customer.example' } }) }) as unknown as Response),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../../../lib/api/quotes', () => ({ sendQuote: vi.fn().mockResolvedValue({ data: { emailed: true } }), deleteQuote: vi.fn(), quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf') }));

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
    // Send unlocks once the billing-contact prefill lands in To.
    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('ap@customer.example'));
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => expect(runAction).toHaveBeenCalled());
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        type: 'success',
        message: "Proposal sent — we'll mark it Viewed and Accepted as Acme Inc. opens and signs.",
      }),
    );
  });
});
