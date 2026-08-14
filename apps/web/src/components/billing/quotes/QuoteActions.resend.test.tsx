import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// Re-send + "copy share link" on an already-sent quote. Before these existed a
// send was a one-shot: a bounced email, a typo'd address or a customer who
// deleted the mail left the tech with no way to get the proposal back in front
// of them, and no way to see the link that had been sent.
const runAction = vi.hoisted(() => vi.fn(async (opts: { request: () => Promise<unknown> }) => opts.request()));
const showToast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  resendQuote: vi.fn(async () => ({ data: { emailed: true, origin: 'reproduced', acceptUrl: 'https://portal.example/quote/tok' } })),
  getQuoteShareLink: vi.fn(async () => ({ data: { acceptUrl: 'https://portal.example/quote/tok', origin: 'reproduced' } })),
}));
vi.mock('../../../lib/runAction', () => ({ runAction, handleActionError: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  // Returns a DIFFERENT address than the recorded recipients, so a test that
  // sees the recorded ones proves the prefill came from the quote's own
  // history rather than the org's current billing contact.
  fetchWithAuth: vi.fn(async () =>
    ({ ok: true, json: async () => ({ billingContact: { email: 'current-billing@customer.example' } }) }) as unknown as Response),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../../../lib/api/quotes', () => ({
  sendQuote: vi.fn(),
  resendQuote: (...args: unknown[]) => api.resendQuote(...(args as [])),
  getQuoteShareLink: (...args: unknown[]) => api.getQuoteShareLink(...(args as [])),
  scheduleQuoteSend: vi.fn(),
  cancelScheduledSend: vi.fn(),
  cloneQuote: vi.fn(),
  deleteQuote: vi.fn(),
  quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf'),
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

const clipboard = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  api.resendQuote.mockResolvedValue({ data: { emailed: true, origin: 'reproduced', acceptUrl: 'https://portal.example/quote/tok' } });
  api.getQuoteShareLink.mockResolvedValue({ data: { acceptUrl: 'https://portal.example/quote/tok', origin: 'reproduced' } });
  clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true });
});

describe('QuoteActions — re-send', () => {
  it('is offered on a sent quote and hidden on a draft', () => {
    const { unmount } = render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    expect(screen.getByTestId('quote-resend')).toBeInTheDocument();
    unmount();

    render(<QuoteActions detail={sent({ status: 'draft', sentAt: null })} onChanged={vi.fn()} variant="rail" />);
    expect(screen.queryByTestId('quote-resend')).not.toBeInTheDocument();
  });

  it.each(['accepted', 'declined', 'converted'])('is hidden on a settled (%s) quote', (status) => {
    render(<QuoteActions detail={sent({ status: status as 'accepted' })} onChanged={vi.fn()} variant="rail" />);
    expect(screen.queryByTestId('quote-resend')).not.toBeInTheDocument();
  });

  // An expired quote's accept link is expired too, and the public accept path
  // enforces expiry independently — re-sending would deliver a dead link.
  it('is hidden on an expired quote', () => {
    render(<QuoteActions detail={sent({ expiryDate: '2020-01-01' })} onChanged={vi.fn()} variant="rail" />);
    expect(screen.queryByTestId('quote-resend')).not.toBeInTheDocument();
  });

  it('prefills To with the addresses the quote already went to, not the org billing contact', async () => {
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    expect(screen.getByTestId('quote-send-to')).toHaveValue('ap@customer.example');
    // And the org lookup must not silently overwrite it moments later.
    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('ap@customer.example'));
  });

  it('falls back to the org billing contact when nothing was recorded (a legacy send)', async () => {
    render(<QuoteActions detail={sent({}, { recipients: [] })} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('current-billing@customer.example'));
  });

  it('dispatches immediately (no undo window) and confirms the link is unchanged', async () => {
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => expect(api.resendQuote).toHaveBeenCalledWith('q-1', { to: ['ap@customer.example'] }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Proposal re-sent to Acme Inc. — same link, same document.',
    }));
  });

  // The confirm dialog promises "the accept link stays the same". When it
  // didn't, that promise has to be corrected — this path emails the customer,
  // so getting it wrong is worse here than on copy-link.
  it('corrects the "same link" promise when the re-send had to issue a new one', async () => {
    api.resendQuote.mockResolvedValue({ data: { emailed: true, origin: 'minted_no_identity', acceptUrl: 'x' } });
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('NEW link'),
    })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('same link'),
    }));
  });

  // An unexpected response shape must not read as success on a path whose
  // whole job is telling the user whether the customer got the email.
  it('does not claim success when the response omits `emailed`', async () => {
    // Deliberately omits `emailed` — the shape a mismatched server version, or
    // a future response change, would produce.
    api.resendQuote.mockResolvedValue({ data: { origin: 'reproduced', acceptUrl: 'x' } } as never);
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  // The server swallows email failures so the request still succeeds. Claiming
  // "re-sent" when nothing was delivered is the exact dishonesty the send path's
  // emailed:false handling exists to avoid.
  it('warns rather than claiming success when no email was delivered', async () => {
    api.resendQuote.mockResolvedValue({ data: { emailed: false, origin: 'reproduced', acceptUrl: 'x' } });
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    fireEvent.click(screen.getByTestId('quote-send-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
  });
});

describe('QuoteActions — copy share link', () => {
  it('copies the link and says it is the one the customer already has', async () => {
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-copy-share-link'));

    await waitFor(() => expect(clipboard).toHaveBeenCalledWith('https://portal.example/quote/tok'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({
      type: 'success',
      message: 'Share link copied — this is the same link the customer was emailed.',
    }));
  });

  // A reissue does NOT revoke the customer's original link (we never stored the
  // parts needed to revoke it) — the copy must not imply that it did.
  it('says the old link still works when the quote merely predates link tracking', async () => {
    api.getQuoteShareLink.mockResolvedValue({ data: { acceptUrl: 'https://portal.example/quote/new', origin: 'minted_no_identity' } });
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-copy-share-link'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('still works'),
    })));
  });

  // The opposite outcome, and the one that used to be reported wrongly: when
  // the signing key is gone the original link no longer verifies at all.
  // Telling the customer it "still works" sends them chasing a dead url.
  it.each(['minted_key_unavailable', 'minted_expired'])('says the old link is dead when it genuinely is (%s)', async (origin) => {
    api.getQuoteShareLink.mockResolvedValue({ data: { acceptUrl: 'https://portal.example/quote/new', origin } });
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-copy-share-link'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('no longer be opened'),
    })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('still works'),
    }));
  });

  // An unknown origin from a newer server must not be guessed at — either
  // story would be a coin flip, and both are consequential.
  it('stays silent about the link when the origin is unrecognized', async () => {
    api.getQuoteShareLink.mockResolvedValue({ data: { acceptUrl: 'https://portal.example/quote/tok', origin: 'something_new' } });
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-copy-share-link'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  // A denied clipboard (insecure origin / permissions policy) must surface the
  // URL rather than leaving a dead-looking button.
  it('shows the link inline when the clipboard write is refused', async () => {
    clipboard.mockRejectedValue(new Error('denied'));
    render(<QuoteActions detail={sent()} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-copy-share-link'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('https://portal.example/quote/tok'),
    })));
  });

  it('is hidden on a draft — there is no link until the quote is sent', () => {
    render(<QuoteActions detail={sent({ status: 'draft', sentAt: null })} onChanged={vi.fn()} variant="rail" />);
    expect(screen.queryByTestId('quote-copy-share-link')).not.toBeInTheDocument();
  });
});
