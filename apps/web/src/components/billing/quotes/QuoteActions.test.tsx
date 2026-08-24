import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// QuoteActions is otherwise exercised only in its 'rail' variant (via QuoteDetail).
// This covers the 'header' variant directly — specifically the empty-quote Send
// guard: the disabled button must point at a per-variant hint id so AT announces
// the reason, and the hint must be visible (not sr-only) in the header.
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// Controllable tokens: opening the composer reads scope claims (Stripe-status
// gate) via useAuthStore.getState().tokens — null keeps it quiet; the
// currency-mismatch tests flip it to partner scope to unlock the fetch.
const authState = vi.hoisted(() => ({ tokens: null as { accessToken: string } | null }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(() => null, { getState: () => ({ tokens: authState.tokens }) }),
}));
import { fetchWithAuth } from '../../../stores/auth';
/** Access token whose (unverified) payload claims partner scope — enough for
 *  the composer's client-side getJwtClaims() gate on the support fetches. */
const PARTNER_TOKENS = {
  accessToken: `x.${btoa(JSON.stringify({ scope: 'partner', partnerId: 'p-1' }))}.y`,
};
vi.mock('../../../lib/api/quotes', () => ({ sendQuote: vi.fn(), deleteQuote: vi.fn(), quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf') }));
vi.mock('../../shared/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToastMock(a) }));

function draft(extra: Partial<QuoteDetailData['quote']> = {}): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: null, introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...extra,
    },
    blocks: [],
    lines: [],
  };
}

/** A draft that Send will actually arm: one customer-visible line. */
function sendable(): QuoteDetailData {
  return {
    ...draft(),
    blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    lines: [{
      id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
      catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
      name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
      customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
      billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }],
  };
}

beforeEach(() => { vi.clearAllMocks(); authState.tokens = null; });

describe('QuoteActions — header variant', () => {
  it('an empty draft disables Send and ties it to a visible, per-variant hint', async () => {
    render(<QuoteActions detail={draft()} onChanged={vi.fn()} variant="header" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    expect(send).toBeDisabled();
    // The hint id is variant-scoped so the rail + header copies never collide.
    expect(send).toHaveAttribute('aria-describedby', 'quote-send-empty-hint-header');

    const hint = screen.getByTestId('quote-send-empty-hint');
    expect(hint).toHaveAttribute('id', 'quote-send-empty-hint-header');
    // Visible (not sr-only) so sighted keyboard users see why Send is disabled.
    expect(hint).not.toHaveClass('sr-only');
    expect(hint).toHaveTextContent('Add at least one item before sending.');
  });

  it('a non-empty draft enables Send and drops the hint + describedby', async () => {
    const withLine: QuoteDetailData = {
      ...draft(),
      blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
      // Send gates on customer-visible LINES (an empty pricing table must not
      // arm it), so a sendable fixture needs an actual line.
      lines: [{
        id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
        catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
        name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
        customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
        billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
      }],
    };
    render(<QuoteActions detail={withLine} onChanged={vi.fn()} variant="header" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    expect(send).not.toBeDisabled();
    expect(send).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByTestId('quote-send-empty-hint')).not.toBeInTheDocument();
  });

  it('formats the zero-total warning in the quote currency', async () => {
    const detail = sendable();
    detail.quote.currencyCode = 'EUR';
    render(<QuoteActions detail={detail} onChanged={vi.fn()} variant="header" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send'));

    expect(await screen.findByTestId('quote-send-zero-warning')).toHaveTextContent('€0.00');
  });

  it('savePending keeps Send ENABLED; a click queues the composer to open on quiescence', async () => {
    const withLine: QuoteDetailData = {
      ...draft(),
      blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
      // Send gates on customer-visible LINES (an empty pricing table must not
      // arm it), so a sendable fixture needs an actual line.
      lines: [{
        id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
        catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
        name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
        customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
        billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
      }],
    };
    const { rerender } = render(<QuoteActions detail={withLine} onChanged={vi.fn()} variant="header" savePending />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    // The button is NOT disabled while edits settle: the click's job is the
    // prerequisite (it blurs the dirty field, starting its save) and queues the
    // composer to open at quiescence — never a dead click at the money moment.
    expect(send).not.toBeDisabled();
    expect(send).toHaveTextContent('Send proposal');
    const hint = screen.getByTestId('quote-send-saving-hint');
    expect(hint).toHaveTextContent('Saving changes… Send unlocks when everything is saved.');

    fireEvent.click(send);
    // Still pending — the composer hasn't opened yet.
    expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();

    // Quiescence arrives → the queued composer opens without another click.
    rerender(<QuoteActions detail={withLine} onChanged={vi.fn()} variant="header" savePending={false} />);
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());
  });

  it('cancels a queued Send when a save FAILURE arrives with quiescence in the same render', async () => {
    // The quote side had no failure signal at all: a blur-save that failed
    // cleared its in-flight key, which read as "quiet", and the composer opened
    // over a stale total. Both props flip in ONE rerender — split across two,
    // the assertion would pass even with the guard ordered wrongly.
    const { rerender } = render(
      <QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" savePending saveFailureNonce={0} />,
    );
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send'));
    expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();

    rerender(
      <QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" savePending={false} saveFailureNonce={1} />,
    );

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await act(async () => {});
    expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();
  });

  it('drops a queued Send after 10s with honest still-saving copy, not a claimed failure', async () => {
    // The old copy ("check your connection and try again") asserted a failure
    // nobody observed — failures are handled by the nonce above, so anything
    // reaching this timer is genuinely still in flight.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" savePending />);
      await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('quote-send'));

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

      expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
      expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a Send click for a field that failed to save, instead of queueing forever', async () => {
    render(<QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" unsavedFieldLabel="Terms & Conditions" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-send-saving-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-send-unsaved-hint')).toHaveTextContent('Terms & Conditions');

    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('Terms & Conditions') }),
    ));
    expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();
  });

  it('re-checks the unsaved-field refusal before opening a queued Send composer', async () => {
    // The click gate tests savePending FIRST, so a click during a deferred
    // delete queues even while an earlier failed save keeps a field dirty
    // (its nonce bump happened BEFORE the click, so the captured nonce never
    // changes). When the editor goes quiet the queue must re-check the label
    // and refuse — opening the composer would quote a stale total.
    const { rerender } = render(
      <QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" savePending unsavedFieldLabel="Terms & Conditions" />,
    );
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send'));
    expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();

    // Quiescence arrives with the field STILL flagged unsaved.
    rerender(
      <QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" savePending={false} unsavedFieldLabel="Terms & Conditions" />,
    );

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('Terms & Conditions') }),
    ));
    await act(async () => {});
    expect(screen.queryByTestId('quote-send-confirm')).not.toBeInTheDocument();
  });

  it('does not spin the Send button on a bare savePending — only on a queued click', async () => {
    // A spinner promises forthcoming completion. Spinning on savePending meant
    // a field left dirty by a failed save spun indefinitely.
    render(<QuoteActions detail={sendable()} onChanged={vi.fn()} variant="header" savePending />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());

    const send = screen.getByTestId('quote-send');
    expect(send.querySelector('.animate-spin')).toBeNull();

    fireEvent.click(send); // now something WILL complete
    expect(send.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('QuoteActions — Stripe currency-mismatch warning (#3777)', () => {
  const resp = (payload: unknown): Response =>
    ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

  /** The warning arrives PRECOMPUTED on the detail payload (GET /quotes/:id).
   *  The composer must never call the BILLING_MANAGE-only
   *  /partner/stripe-connect endpoint for it: `quotes:send` is independently
   *  grantable, and a sender without billing admin got a silent 403 and no
   *  warning (review F5). The mock below 403s that endpoint to prove it. */
  function mockSenderWithoutBillingManage() {
    vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
      if (url === '/partner/stripe-connect') {
        return { ok: false, status: 403, statusText: 'Forbidden', json: vi.fn().mockResolvedValue({ error: 'Forbidden' }) } as unknown as Response;
      }
      if (url === '/orgs/partners/me') return resp({ emailSignature: null });
      return resp({ data: {} });
    });
  }

  function withStripe(detail: QuoteDetailData, accountCurrency: string | null): QuoteDetailData {
    const doc = detail.quote.currencyCode;
    const currencyWarning: QuoteDetailData['currencyWarning'] = accountCurrency === null
      ? { code: 'STRIPE_ACCOUNT_CURRENCY_UNKNOWN', documentCurrency: doc, accountCurrency: null, message: 'not cached — refresh' }
      : accountCurrency === doc
        ? null
        : { code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT', documentCurrency: doc, accountCurrency, message: 'differs' };
    return { ...detail, stripeConnected: true, stripeAccountCurrency: accountCurrency, currencyWarning };
  }

  async function openComposer(detail: QuoteDetailData) {
    render(<QuoteActions detail={detail} onChanged={vi.fn()} variant="header" />);
    await waitFor(() => expect(screen.getByTestId('quote-actions-header')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());
  }

  beforeEach(() => { mockSenderWithoutBillingManage(); });

  it('warns when the quote currency differs from the Stripe account default — for a quotes:send-only user, without calling /partner/stripe-connect', async () => {
    authState.tokens = PARTNER_TOKENS;
    await openComposer(withStripe({ ...sendable(), quote: { ...sendable().quote, currencyCode: 'EUR' } }, 'USD'));
    const warning = await screen.findByTestId('quote-stripe-currency-warning');
    expect(warning.textContent).toContain('EUR');
    expect(warning.textContent).toContain('USD');
    // Warn, never block: the connected note still renders and Send stays armed.
    expect(screen.getByTestId('quote-send-payment-enabled')).toBeInTheDocument();
    expect(screen.getByTestId('quote-send-confirm')).not.toBeDisabled();
    expect(vi.mocked(fetchWithAuth).mock.calls.map(([u]) => u)).not.toContain('/partner/stripe-connect');
  });

  it('stays silent when the currencies match', async () => {
    authState.tokens = PARTNER_TOKENS;
    await openComposer(withStripe(sendable(), 'USD'));
    await screen.findByTestId('quote-send-payment-enabled');
    expect(screen.queryByTestId('quote-stripe-currency-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-stripe-currency-unknown')).not.toBeInTheDocument();
  });

  it('account currency not cached (null): shows an explicit "refresh required" note instead of silence (review F6)', async () => {
    authState.tokens = PARTNER_TOKENS;
    await openComposer(withStripe({ ...sendable(), quote: { ...sendable().quote, currencyCode: 'EUR' } }, null));
    await screen.findByTestId('quote-send-payment-enabled');
    expect(screen.queryByTestId('quote-stripe-currency-warning')).not.toBeInTheDocument();
    const note = screen.getByTestId('quote-stripe-currency-unknown');
    expect(note.textContent).toMatch(/refresh/i);
    // Warn, never block.
    expect(screen.getByTestId('quote-send-confirm')).not.toBeDisabled();
  });

  it('does not render the warning for an org-scoped token either — the payload decides, not the token', async () => {
    authState.tokens = null;
    await openComposer(withStripe({ ...sendable(), quote: { ...sendable().quote, currencyCode: 'EUR' } }, 'USD'));
    expect(await screen.findByTestId('quote-stripe-currency-warning')).toBeInTheDocument();
  });

  it('stripeConnected unknown (null / omitted): neither the connected note nor a warning, even if a stale warning is present', async () => {
    authState.tokens = PARTNER_TOKENS;
    const stale = withStripe({ ...sendable(), quote: { ...sendable().quote, currencyCode: 'EUR' } }, 'USD');
    await openComposer({ ...stale, stripeConnected: null });
    expect(screen.queryByTestId('quote-send-payment-enabled')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-send-payment-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-stripe-currency-warning')).not.toBeInTheDocument();
  });

  it('stripeConnected false: the disconnected note renders and no currency warning can', async () => {
    authState.tokens = PARTNER_TOKENS;
    await openComposer({ ...sendable(), stripeConnected: false, currencyWarning: null });
    expect(await screen.findByTestId('quote-send-payment-note')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-stripe-currency-warning')).not.toBeInTheDocument();
  });
});
