import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// "Decline on behalf" (#6634): the tech records a customer's decline that
// arrived by phone, email or letter. Same authority and evidence rule as Accept
// on behalf — quotes:accept, and no record without a reference — but only on a
// quote the customer has actually been sent.
const runAction = vi.hoisted(() => vi.fn(async (opts: { request: () => Promise<unknown> }) => opts.request()));
const showToast = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ granted: ['quotes:read', 'quotes:send', 'quotes:accept'] }));
const api = vi.hoisted(() => ({
  declineQuoteOnBehalf: vi.fn(async () => ({ data: { id: 'q-1', status: 'declined' } })),
}));
vi.mock('../../../lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/runAction')>();
  return { ...actual, runAction, handleActionError: vi.fn() };
});
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('../../../lib/permissions', () => ({
  usePermissions: () => ({ can: (r: string, a: string) => perms.granted.includes(`${r}:${a}`) }),
}));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () =>
    ({ ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: true }) }) as unknown as Response),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../../../lib/api/quotes', () => ({
  sendQuote: vi.fn(),
  resendQuote: vi.fn(),
  getQuoteShareLink: vi.fn(),
  scheduleQuoteSend: vi.fn(),
  cancelScheduledSend: vi.fn(),
  cloneQuote: vi.fn(),
  reviseQuote: vi.fn(),
  deleteQuote: vi.fn(),
  quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf'),
  acceptQuoteOnBehalf: vi.fn(),
  declineQuoteOnBehalf: (...args: unknown[]) => api.declineQuoteOnBehalf(...(args as [])),
}));

function detail(extra: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: 'Q-2026-0001', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'sent',
      currencyCode: 'USD', issueDate: '2026-06-01', expiryDate: null, subtotal: '100.00', taxRate: null,
      taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '100.00', billToName: 'Acme Inc.', introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: '2026-06-01T10:00:00Z', viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...extra,
    },
    blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    lines: [{
      id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
      catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
      name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
      customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
      billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }],
    recipients: ['ap@customer.example'],
  };
}

function openDialog(): void {
  fireEvent.click(screen.getByTestId('quote-decline-on-behalf'));
}

beforeEach(() => {
  vi.clearAllMocks();
  perms.granted = ['quotes:read', 'quotes:send', 'quotes:accept'];
  api.declineQuoteOnBehalf.mockResolvedValue({ data: { id: 'q-1', status: 'declined' } });
});

describe('Decline on behalf', () => {
  it('hides the button without quotes:accept, even for a sender', () => {
    perms.granted = ['quotes:read', 'quotes:send', 'quotes:write'];
    render(<QuoteActions detail={detail()} variant="header" onChanged={vi.fn()} />);
    expect(screen.queryByTestId('quote-decline-on-behalf')).toBeNull();
  });

  it.each(['sent', 'viewed'] as const)('offers the button on %s', (status) => {
    render(<QuoteActions detail={detail({ status })} variant="header" onChanged={vi.fn()} />);
    expect(screen.getByTestId('quote-decline-on-behalf')).toBeTruthy();
  });

  // A draft the customer never saw is deleted, not declined; the rest are settled.
  it.each(['draft', 'accepted', 'declined', 'expired', 'converted', 'superseded'] as const)('hides it on %s', (status) => {
    render(<QuoteActions detail={detail({ status })} variant="header" onChanged={vi.fn()} />);
    expect(screen.queryByTestId('quote-decline-on-behalf')).toBeNull();
  });

  it('blocks submission until a reference is entered', () => {
    render(<QuoteActions detail={detail()} variant="header" onChanged={vi.fn()} />);
    openDialog();
    expect(screen.getByTestId('decline-on-behalf-submit').hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByTestId('decline-on-behalf-reference'), { target: { value: '   ' } });
    expect(screen.getByTestId('decline-on-behalf-submit').hasAttribute('disabled')).toBe(true);
  });

  it('submits method, reference and reason through runAction, then closes and refreshes', async () => {
    const refresh = vi.fn();
    render(<QuoteActions detail={detail()} variant="header" onChanged={refresh} />);
    openDialog();
    fireEvent.change(screen.getByTestId('decline-on-behalf-method'), { target: { value: 'email' } });
    fireEvent.change(screen.getByTestId('decline-on-behalf-reference'), { target: { value: ' Email from J. Doe ' } });
    fireEvent.change(screen.getByTestId('decline-on-behalf-reason'), { target: { value: 'Went with another vendor' } });
    fireEvent.click(screen.getByTestId('decline-on-behalf-submit'));
    await waitFor(() => expect(api.declineQuoteOnBehalf).toHaveBeenCalledWith('q-1', {
      method: 'email', reference: 'Email from J. Doe', reason: 'Went with another vendor',
    }));
    expect(runAction).toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('decline-on-behalf-submit')).toBeNull());
  });

  it('omits a blank reason instead of sending an empty string', async () => {
    render(<QuoteActions detail={detail()} variant="header" onChanged={vi.fn()} />);
    openDialog();
    fireEvent.change(screen.getByTestId('decline-on-behalf-reference'), { target: { value: 'Call with owner' } });
    fireEvent.click(screen.getByTestId('decline-on-behalf-submit'));
    await waitFor(() => expect(api.declineQuoteOnBehalf).toHaveBeenCalledWith('q-1', {
      method: 'verbal', reference: 'Call with owner',
    }));
  });

  it('does not refresh or close when the decline fails', async () => {
    const refresh = vi.fn();
    const { ActionError } = await import('../../../lib/runAction');
    runAction.mockRejectedValueOnce(new ActionError('nope', 409, 'QUOTE_NOT_DECLINABLE'));
    render(<QuoteActions detail={detail()} variant="header" onChanged={refresh} />);
    openDialog();
    fireEvent.change(screen.getByTestId('decline-on-behalf-reference'), { target: { value: 'Call with owner' } });
    fireEvent.click(screen.getByTestId('decline-on-behalf-submit'));
    await waitFor(() => expect(runAction).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('decline-on-behalf-submit')).toBeTruthy();
    // runAction already toasted the 409 — no second toast on top of it.
    expect(showToast).not.toHaveBeenCalled();
  });

  it('neither toasts nor refreshes on a 401', async () => {
    const refresh = vi.fn();
    const { ActionError } = await import('../../../lib/runAction');
    runAction.mockRejectedValueOnce(new ActionError('Unauthorized', 401));
    render(<QuoteActions detail={detail()} variant="header" onChanged={refresh} />);
    openDialog();
    fireEvent.change(screen.getByTestId('decline-on-behalf-reference'), { target: { value: 'Call with owner' } });
    fireEvent.click(screen.getByTestId('decline-on-behalf-submit'));
    await waitFor(() => expect(runAction).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
