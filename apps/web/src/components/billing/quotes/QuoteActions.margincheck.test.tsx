import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import { SHOW_INTERNAL_MARGIN_KEY } from '../billingUi';
import { fetchWithAuth } from '../../../stores/auth';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// Task 3 of the quote-editor UX pass: a NON-BLOCKING send-time notice when the
// profit estimate is incomplete (some billed line has no cost) — visible only
// to users who can already see margin (quotes:read) AND currently have the
// "show cost & margin" preference on (the toggle's contract is "no margin on
// screen", and the send dialog is a screen too), never disabling Send.
const state = vi.hoisted(() => ({ canSeeMargin: true }));
vi.mock('../../../lib/permissions', () => ({
  usePermissions: () => ({ can: (resource: string, action: string) => {
    if (resource === 'quotes' && action === 'read') return state.canSeeMargin;
    return true; // quotes:send / quotes:write etc. stay granted for these tests
  } }),
}));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () =>
    ({ ok: true, json: async () => ({ billingContact: { email: 'ap@customer.example' } }) }) as unknown as Response),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
const scheduleQuoteSendMock = vi.fn().mockResolvedValue({ data: { sendScheduledAt: '2099-01-01T00:00:00Z' } });
vi.mock('../../../lib/api/quotes', () => ({
  sendQuote: vi.fn(),
  scheduleQuoteSend: (...args: unknown[]) => scheduleQuoteSendMock(...args),
  cancelScheduledSend: vi.fn(),
  deleteQuote: vi.fn(),
  quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf'),
}));

function draft(lines: QuoteDetailData['lines']): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: 'Acme Inc.', introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    lines,
  };
}

const lineMissingCost: QuoteDetailData['lines'][number] = {
  id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
  customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
  billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const lineWithCost: QuoteDetailData['lines'][number] = {
  ...lineMissingCost, id: 'l-2', unitCost: '40.00',
};

beforeEach(() => {
  vi.clearAllMocks();
  scheduleQuoteSendMock.mockResolvedValue({ data: { sendScheduledAt: '2099-01-01T00:00:00Z' } });
  state.canSeeMargin = true;
  // Re-pin the org-prefill response: the no-contact-hint tests below override
  // the implementation, and clearAllMocks does not restore implementations.
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    ({ ok: true, json: async () => ({ billingContact: { email: 'ap@customer.example' } }) }) as unknown as Response);
  // The notice is additionally gated on the persisted margin-visibility
  // preference (default off) — turn it on so the permission cases below test
  // what they mean to test.
  localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
});

describe('QuoteActions — send-time incomplete-profit notice', () => {
  it('shows a non-blocking notice when a billed line has no cost and the user can see margin', async () => {
    render(<QuoteActions detail={draft([lineMissingCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());

    const notice = screen.getByTestId('quote-send-missing-cost-notice');
    expect(notice).toHaveTextContent('Profit estimate is incomplete — 1 line missing a cost.');
    // Non-blocking: Send stays enabled with the notice showing.
    expect(screen.getByTestId('quote-send-confirm')).not.toBeDisabled();
  });

  it('is absent when every billed line has a cost', async () => {
    render(<QuoteActions detail={draft([lineWithCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-send-missing-cost-notice')).not.toBeInTheDocument();
  });

  it('is absent for a user without margin visibility, even with a missing cost', async () => {
    state.canSeeMargin = false;
    render(<QuoteActions detail={draft([lineMissingCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-send-missing-cost-notice')).not.toBeInTheDocument();
  });

  it('is absent while "Hide cost & margin" is on — the toggle governs the send dialog too', async () => {
    // A tech hides margin precisely because a client is watching the screen;
    // the send dialog is the moment the client is MOST likely watching, so the
    // internal cost-tracking notice must honor the same contract.
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '0');
    render(<QuoteActions detail={draft([lineMissingCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-send-missing-cost-notice')).not.toBeInTheDocument();
  });

  // ---- the "why is To empty" hint (no-billing-contact) ---------------------
  // The contract is precise: the hint renders only when the org lookup
  // SUCCEEDS with no email — a failed lookup must stay silent, because
  // "unknown" is not "absent" and the hint would be a false claim.
  it('explains an empty To when the org confirmably has no billing contact, until an address is typed', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      ({ ok: true, json: async () => ({ billingContact: null }) }) as unknown as Response);

    render(<QuoteActions detail={draft([lineWithCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-to-no-contact')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('quote-send-to'), { target: { value: 'ap@customer.example' } });
    expect(screen.queryByTestId('quote-send-to-no-contact')).not.toBeInTheDocument();
  });

  it('stays silent about billing contacts when the org lookup fails', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => { throw new Error('network'); });

    render(<QuoteActions detail={draft([lineWithCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-send-to-no-contact')).not.toBeInTheDocument();
  });

  it('sending still works with the notice showing', async () => {
    render(<QuoteActions detail={draft([lineMissingCost])} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('ap@customer.example'));
    expect(screen.getByTestId('quote-send-missing-cost-notice')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() => expect(scheduleQuoteSendMock).toHaveBeenCalledWith('q-1', expect.objectContaining({ to: ['ap@customer.example'] })));
  });
});
