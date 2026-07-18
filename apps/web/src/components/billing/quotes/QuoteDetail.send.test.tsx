import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import * as quotesApi from '../../../lib/api/quotes';
import { fetchWithAuth } from '../../../stores/auth';
import type { QuoteDetail as QuoteDetailData, QuoteLine } from './quoteTypes';

// Same auth-mock pattern as QuoteDetail.delete.test.tsx, plus controllable
// tokens so tests can flip the JWT scope the send composer reads (partner
// scope unlocks the signature/Stripe support fetches).
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({
  permissions: [] as Perm[],
  tokens: null as { accessToken: string } | null,
}));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: state.tokens }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../../../lib/api/quotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api/quotes')>();
  return { ...actual, sendQuote: vi.fn(), scheduleQuoteSend: vi.fn(), cancelScheduledSend: vi.fn() };
});

const resp = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const line: QuoteLine = {
  id: 'l-1', quoteId: 'q-1', blockId: null, orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, name: null, description: 'Onboarding', quantity: '1',
  unitPrice: '500.00', unitCost: null, sku: null, partNumber: null, taxable: false,
  customerVisible: true, lineTotal: '500.00',
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

/** Access token whose (unverified) payload claims partner scope — enough for
 *  the composer's client-side getJwtClaims() gate on the support fetches. */
const PARTNER_TOKENS = {
  accessToken: `x.${btoa(JSON.stringify({ scope: 'partner', partnerId: 'p-1' }))}.y`,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'quotes', action: 'send' }];
  state.tokens = null;
  vi.mocked(quotesApi.scheduleQuoteSend).mockResolvedValue(
    resp({ data: { sendScheduledAt: new Date(Date.now() + 30_000).toISOString() } }),
  );
  // The composer's prefill/support fetches, routed by URL (not call order).
  vi.mocked(fetchWithAuth).mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations/')) return resp({ billingContact: { email: 'ap@customer.example' } });
    if (url === '/orgs/partners/me') return resp({ emailSignature: null });
    if (url === '/partner/stripe-connect') return resp({ status: 'disconnected' });
    return resp({}, false);
  });
});

/** Open the composer and wait for the billing-contact prefill (Send stays
 *  disabled until To holds at least one valid address). */
async function openComposer() {
  fireEvent.click(screen.getByTestId('quote-send'));
  await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('ap@customer.example'));
}

describe('QuoteDetail — send proposal', () => {
  it('disables Send and shows a hint when the quote has no content', async () => {
    render(<QuoteDetail detail={emptyDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.getByTestId('quote-send')).toBeDisabled();
    expect(screen.getByTestId('quote-send-empty-hint')).toBeInTheDocument();
  });

  it('does not schedule on the first click — it opens a confirm step first', async () => {
    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('quote-send'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());
    // Critical: nothing irreversible may start from the first click.
    expect(quotesApi.scheduleQuoteSend).not.toHaveBeenCalled();
    expect(quotesApi.sendQuote).not.toHaveBeenCalled();
  });

  it('confirm SCHEDULES the delayed send (not an immediate email) and refreshes', async () => {
    const scheduleQuoteSend = vi.mocked(quotesApi.scheduleQuoteSend);
    const onChanged = vi.fn();

    render(<QuoteDetail detail={filledDraft} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() => {
      // Untouched composer → only the (prefilled, user-visible) To list goes out;
      // blank subject/message and the default includePdf are omitted.
      expect(scheduleQuoteSend).toHaveBeenCalledWith('q-1', { to: ['ap@customer.example'] });
      expect(onChanged).toHaveBeenCalled();
    });
    // The undo window means the direct-send endpoint is never hit from here.
    expect(quotesApi.sendQuote).not.toHaveBeenCalled();
  });

  it('confirm shows the "you can still undo" toast, not a sent-success toast', async () => {
    const { showToast } = await import('../../shared/Toast');

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'success',
        message: expect.stringContaining('undo'),
      }));
    });
  });

  it('the draft→sent flip surfaces a WARNING toast when the worker recorded an email failure', async () => {
    const { showToast } = await import('../../shared/Toast');

    // Simulate the countdown's reload landing the flip: same component, quote
    // now Sent with the worker-persisted outcome (e.g. no billing contact —
    // the black hole this regression-guards).
    const { rerender } = render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    rerender(<QuoteDetail
      detail={{
        ...filledDraft,
        quote: { ...filledDraft.quote, status: 'sent', sentAt: '2026-06-01T00:01:00Z', sendEmailReason: 'no_billing_contact' },
      }}
      onChanged={vi.fn()}
    />);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining('no email was delivered'),
      }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it.each([
    ['no_email_service', 'not configured'],
    ['send_failed', 'could not be delivered'],
    ['pdf_render_failed', 'PDF could not be generated'],
  ])('the flip shows a distinct WARNING toast for sendEmailReason %s', async (reason, fragment) => {
    const { showToast } = await import('../../shared/Toast');

    const { rerender } = render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    rerender(<QuoteDetail
      detail={{
        ...filledDraft,
        quote: { ...filledDraft.quote, status: 'sent', sentAt: '2026-06-01T00:01:00Z', sendEmailReason: reason },
      }}
      onChanged={vi.fn()}
    />);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining(fragment),
      }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('the flip shows the success toast when the email actually went out', async () => {
    const { showToast } = await import('../../shared/Toast');

    const { rerender } = render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    rerender(<QuoteDetail
      detail={{
        ...filledDraft,
        quote: { ...filledDraft.quote, status: 'sent', sentAt: '2026-06-01T00:01:00Z', sendEmailReason: null },
      }}
      onChanged={vi.fn()}
    />);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('a scheduled draft shows the countdown + Undo instead of Send, and Undo cancels', async () => {
    const cancelScheduledSend = vi.mocked(quotesApi.cancelScheduledSend);
    cancelScheduledSend.mockResolvedValue(resp({ data: { canceled: true } }));
    const onChanged = vi.fn();

    render(<QuoteDetail
      detail={{
        ...filledDraft,
        quote: { ...filledDraft.quote, sendScheduledAt: new Date(Date.now() + 25_000).toISOString() },
      }}
      onChanged={onChanged}
    />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.queryByTestId('quote-send')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-send-countdown')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('quote-send-undo'));
    await waitFor(() => {
      expect(cancelScheduledSend).toHaveBeenCalledWith('q-1');
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it('a PAST sendScheduledAt on a draft is treated as not scheduled (plain Send shows)', async () => {
    render(<QuoteDetail
      detail={{
        ...filledDraft,
        quote: { ...filledDraft.quote, sendScheduledAt: new Date(Date.now() - 5_000).toISOString() },
      }}
      onChanged={vi.fn()}
    />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    expect(screen.getByTestId('quote-send')).toBeInTheDocument();
    expect(screen.queryByTestId('quote-send-undo')).not.toBeInTheDocument();
  });

  it('forwards a typed personal message to the schedule call', async () => {
    const scheduleQuoteSend = vi.mocked(quotesApi.scheduleQuoteSend);

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-message'), { target: { value: 'Thanks for your business!' } });

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() =>
      expect(scheduleQuoteSend).toHaveBeenCalledWith('q-1', { to: ['ap@customer.example'], message: 'Thanks for your business!' }),
    );
  });

  it('forwards To/Cc/Subject/includePdf overrides to the schedule call', async () => {
    const scheduleQuoteSend = vi.mocked(quotesApi.scheduleQuoteSend);

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-to'), { target: { value: 'a@x.com, b@x.com' } });
    // Cc starts collapsed behind the toggle, like a mail client.
    expect(screen.queryByTestId('quote-send-cc')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quote-send-cc-toggle'));
    fireEvent.change(screen.getByTestId('quote-send-cc'), { target: { value: 'c@x.com' } });
    fireEvent.change(screen.getByTestId('quote-send-subject'), { target: { value: 'Custom subject' } });
    fireEvent.click(screen.getByTestId('quote-send-include-pdf'));

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() =>
      expect(scheduleQuoteSend).toHaveBeenCalledWith('q-1', {
        to: ['a@x.com', 'b@x.com'],
        cc: ['c@x.com'],
        subject: 'Custom subject',
        includePdf: false,
      }),
    );
  });

  it('an invalid To keeps the inline error, and clicking Send focuses the field instead of scheduling', async () => {
    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-to'), { target: { value: 'not-an-email' } });

    // Send stays ENABLED — its click performs the prerequisite (focus the To
    // field) rather than sitting dead; nothing is scheduled while invalid.
    const confirm = screen.getByTestId('quote-send-confirm');
    expect(confirm).not.toBeDisabled();
    expect(screen.getByTestId('quote-send-to-error')).toHaveTextContent('not-an-email');
    fireEvent.click(confirm);
    expect(quotesApi.scheduleQuoteSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('quote-send-to')).toHaveFocus();
  });

  it('an EMPTY To gets a visible reason on Send click (no silent dead button)', async () => {
    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-to'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    expect(quotesApi.scheduleQuoteSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('quote-send-to-missing')).toBeInTheDocument();
    expect(screen.getByTestId('quote-send-to')).toHaveFocus();
  });

  it('warns when a deposit is configured but Stripe is not connected', async () => {
    // Partner scope unlocks the Stripe-status fetch (mocked to 'disconnected').
    state.tokens = PARTNER_TOKENS;
    const withDeposit: QuoteDetailData = {
      ...filledDraft,
      quote: { ...filledDraft.quote, depositType: 'percent', depositPercent: '30.00' },
    };

    render(<QuoteDetail detail={withDeposit} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    await waitFor(() => expect(screen.getByTestId('quote-send-payment-warning')).toBeInTheDocument());
  });
});
