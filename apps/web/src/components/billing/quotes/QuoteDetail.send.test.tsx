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
  return { ...actual, sendQuote: vi.fn() };
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

    await openComposer();

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() => {
      // Untouched composer → only the (prefilled, user-visible) To list goes out;
      // blank subject/message and the default includePdf are omitted.
      expect(sendQuote).toHaveBeenCalledWith('q-1', { to: ['ap@customer.example'] });
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it('shows a WARNING toast (not success) when the send committed but no email went out', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    // The API's email step is best-effort: emailed:false means the quote
    // flipped to Sent but the customer received nothing (e.g. the org has no
    // billing contact email — the black hole this regression-guards).
    sendQuote.mockResolvedValue(resp({ data: { emailed: false, emailReason: 'no_billing_contact' } }));
    const { showToast } = await import('../../shared/Toast');

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

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
  ])('shows a distinct WARNING toast for emailReason %s', async (reason, fragment) => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    sendQuote.mockResolvedValue(resp({ data: { emailed: false, emailReason: reason } }));
    const { showToast } = await import('../../shared/Toast');

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'warning',
        message: expect.stringContaining(fragment),
      }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows the success toast when the email actually went out', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    sendQuote.mockResolvedValue(resp({ data: { emailed: true } }));
    const { showToast } = await import('../../shared/Toast');

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });

  it('forwards a typed personal message to the send call', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    sendQuote.mockResolvedValue(resp({ data: null }));

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-message'), { target: { value: 'Thanks for your business!' } });

    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() =>
      expect(sendQuote).toHaveBeenCalledWith('q-1', { to: ['ap@customer.example'], message: 'Thanks for your business!' }),
    );
  });

  it('forwards To/Cc/Subject/includePdf overrides to the send call', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);
    sendQuote.mockResolvedValue(resp({ data: null }));

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
      expect(sendQuote).toHaveBeenCalledWith('q-1', {
        to: ['a@x.com', 'b@x.com'],
        cc: ['c@x.com'],
        subject: 'Custom subject',
        includePdf: false,
      }),
    );
  });

  it('an invalid To keeps the inline error, and clicking Send focuses the field instead of sending', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-to'), { target: { value: 'not-an-email' } });

    // Send stays ENABLED — its click performs the prerequisite (focus the To
    // field) rather than sitting dead; nothing is sent while invalid.
    const confirm = screen.getByTestId('quote-send-confirm');
    expect(confirm).not.toBeDisabled();
    expect(screen.getByTestId('quote-send-to-error')).toHaveTextContent('not-an-email');
    fireEvent.click(confirm);
    expect(sendQuote).not.toHaveBeenCalled();
    expect(screen.getByTestId('quote-send-to')).toHaveFocus();
  });

  it('an EMPTY To gets a visible reason on Send click (no silent dead button)', async () => {
    const sendQuote = vi.mocked(quotesApi.sendQuote);

    render(<QuoteDetail detail={filledDraft} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());

    await openComposer();
    fireEvent.change(screen.getByTestId('quote-send-to'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    expect(sendQuote).not.toHaveBeenCalled();
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
