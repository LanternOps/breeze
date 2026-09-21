import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// "Accept on behalf": the tech records a customer's agreement that arrived by
// phone, email or purchase order. It runs the full conversion — the invoice is
// numbered and issued immediately — so the dialog's job is to state the
// consequences BEFORE they happen, and to refuse to record a claim with no
// evidence behind it.
const runAction = vi.hoisted(() => vi.fn(async (opts: { request: () => Promise<unknown> }) => opts.request()));
const showToast = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ granted: ['quotes:read', 'quotes:send', 'quotes:accept'] }));
const api = vi.hoisted(() => ({
  acceptQuoteOnBehalf: vi.fn(async () => ({
    data: { quote: { id: 'q-1', quoteNumber: 'Q-2026-0001' }, invoiceId: 'inv-1', invoiceIssued: true, contractIds: [], payUrl: null },
  })),
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
  // The partner billing settings read the dialog does on open — `/orgs/partners/me`.
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
  acceptQuoteOnBehalf: (...args: unknown[]) => api.acceptQuoteOnBehalf(...(args as [])),
}));

function sent(
  extra: Partial<QuoteDetailData['quote']> = {},
  detailExtra: Partial<QuoteDetailData> = {},
): QuoteDetailData {
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
    ...detailExtra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  perms.granted = ['quotes:read', 'quotes:send', 'quotes:accept'];
  api.acceptQuoteOnBehalf.mockResolvedValue({
    data: { quote: { id: 'q-1', quoteNumber: 'Q-2026-0001' }, invoiceId: 'inv-1', invoiceIssued: true, contractIds: [], payUrl: null },
  });
});

describe('Accept on behalf', () => {
  // Hidden, not disabled, when the permission is missing — matching every other
  // quote action.
  it('hides the button without quotes:accept', () => {
    perms.granted = ['quotes:read', 'quotes:send'];
    render(<QuoteActions detail={sent()} variant="header" onChanged={vi.fn()} />);
    expect(screen.queryByTestId('quote-accept-on-behalf')).toBeNull();
  });

  it.each(['draft', 'sent', 'viewed'] as const)('offers the button on %s', (status) => {
    render(<QuoteActions detail={sent({ status })} variant="header" onChanged={vi.fn()} />);
    expect(screen.getByTestId('quote-accept-on-behalf')).toBeTruthy();
  });

  it.each(['expired', 'declined', 'converted', 'superseded'] as const)('hides it on %s', (status) => {
    render(<QuoteActions detail={sent({ status })} variant="header" onChanged={vi.fn()} />);
    expect(screen.queryByTestId('quote-accept-on-behalf')).toBeNull();
  });

  // "This quote was never sent. The customer's first sight of it will be the
  // invoice." — the one consequence a tech cannot undo by voiding the invoice.
  it('warns about a never-sent draft, and only on a draft', () => {
    render(<QuoteActions detail={sent({ status: 'draft' })} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.getByTestId('accept-on-behalf-draft-warning')).toBeTruthy();
  });

  it('shows no draft warning on a sent quote', () => {
    render(<QuoteActions detail={sent({ status: 'sent' })} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.queryByTestId('accept-on-behalf-draft-warning')).toBeNull();
  });

  it('blocks submission until a reference is entered', () => {
    render(<QuoteActions detail={sent()} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.getByTestId('accept-on-behalf-submit').hasAttribute('disabled')).toBe(true);
  });

  it('prefills the signer name from billToName and never from an email address', () => {
    render(<QuoteActions detail={sent({ billToName: 'Acme Inc.' })} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect((screen.getByTestId('accept-on-behalf-signer-name') as HTMLInputElement).value).toBe('Acme Inc.');
  });

  // A company with no bill-to name leaves the field BLANK. Deriving "ap" from
  // ap@customer.example would put a mailbox prefix where a person's name is
  // supposed to be, in a record whose whole purpose is evidence.
  it('leaves the signer name blank rather than deriving one from the recipient address', () => {
    render(<QuoteActions detail={sent({ billToName: null })} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect((screen.getByTestId('accept-on-behalf-signer-name') as HTMLInputElement).value).toBe('');
    // …and with no name there is nothing to record, so submit stays closed.
    fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'PO 1' } });
    expect(screen.getByTestId('accept-on-behalf-submit').hasAttribute('disabled')).toBe(true);
  });

  it('submits the typed body through runAction and refreshes', async () => {
    const refresh = vi.fn();
    render(<QuoteActions detail={sent()} variant="header" onChanged={refresh} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    fireEvent.change(screen.getByTestId('accept-on-behalf-method'), { target: { value: 'purchase_order' } });
    fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'PO 4471' } });
    fireEvent.click(screen.getByTestId('accept-on-behalf-submit'));
    await waitFor(() => expect(api.acceptQuoteOnBehalf).toHaveBeenCalledWith('q-1', {
      method: 'purchase_order', reference: 'PO 4471',
      signerName: 'Acme Inc.', signerEmail: 'ap@customer.example',
    }));
    expect(runAction).toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  // Recurring lines become draft contracts. Saying so on a quote that has none
  // would be a promise of paperwork that never appears.
  it('mentions draft contracts only when the quote has recurring lines', () => {
    const { unmount } = render(<QuoteActions detail={sent()} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.queryByTestId('accept-on-behalf-consequence-contracts')).toBeNull();
    unmount();

    const recurring = sent();
    recurring.lines[0] = { ...recurring.lines[0], recurrence: 'monthly' };
    render(<QuoteActions detail={recurring} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.getByTestId('accept-on-behalf-consequence-contracts')).toBeTruthy();
  });

  // The invoice amount is the number the tech is about to commit the customer
  // to — it has to be on screen before the click, not after.
  it('names the amount about to be invoiced', () => {
    render(<QuoteActions detail={sent()} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    expect(screen.getByTestId('accept-on-behalf-consequence-invoice').textContent).toContain('100.00');
  });

  // The partner can have auto-email off; promising the customer an email that
  // never arrives is worse than saying nothing.
  it('promises the customer email only when the partner has auto-email on', async () => {
    const { fetchWithAuth } = await import('../../../stores/auth');
    (fetchWithAuth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: false }) } as unknown as Response,
    );
    render(<QuoteActions detail={sent()} variant="header" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me'));
    await waitFor(() => expect(screen.queryByTestId('accept-on-behalf-consequence-email')).toBeNull());
  });

  // A failure must not leave the tech believing the deal is closed: the dialog
  // stays open and nothing is refreshed away underneath them.
  it('does not refresh or close when the accept fails', async () => {
    const refresh = vi.fn();
    const { ActionError } = await import('../../../lib/runAction');
    runAction.mockRejectedValueOnce(new ActionError('nope', 409, 'QUOTE_NOT_ACCEPTABLE'));
    render(<QuoteActions detail={sent()} variant="header" onChanged={refresh} />);
    fireEvent.click(screen.getByTestId('quote-accept-on-behalf'));
    fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'PO 4471' } });
    fireEvent.click(screen.getByTestId('accept-on-behalf-submit'));
    await waitFor(() => expect(runAction).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('accept-on-behalf-submit')).toBeTruthy();
    // runAction already toasted the 409 — no second toast on top of it.
    expect(showToast).not.toHaveBeenCalled();
  });
});
