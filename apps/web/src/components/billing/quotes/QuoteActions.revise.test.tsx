import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';
import { ActionError } from '../../../lib/runAction';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  reviseQuote: vi.fn(),
  navigateTo: vi.fn(),
  runAction: vi.fn(),
  showToast: vi.fn(),
  organizations: [] as Array<{ id: string; name: string }>,
}));

vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ can: mocks.can }) }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: mocks.organizations }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: mocks.navigateTo }));
// The send composer fires background support fetches (billing contact,
// signature) that reach useAuthStore. Without it here those land as Vitest
// "unhandled errors" after the test finishes — green, but flagged as capable of
// producing false positives.
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue(
    { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue({ data: {} }) } as unknown as Response,
  ),
  useAuthStore: Object.assign(() => null, { getState: () => ({ tokens: null }) }),
}));
vi.mock('../../../lib/api/quotes', () => ({
  reviseQuote: mocks.reviseQuote,
  cloneQuote: vi.fn(),
  sendQuote: vi.fn(),
  deleteQuote: vi.fn(),
  quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf'),
}));
// Keep the REAL ActionError class so the component's `instanceof` check resolves
// against the same constructor this test throws.
vi.mock('../../../lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/runAction')>();
  return { ...actual, runAction: mocks.runAction, handleActionError: vi.fn() };
});
vi.mock('../../shared/Toast', () => ({ showToast: mocks.showToast }));
vi.mock('../../shared/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const detailWith = (over: Partial<QuoteDetailData['quote']> = {}, rest: Partial<QuoteDetailData> = {}): QuoteDetailData => ({
  quote: {
    id: 'q-1', quoteNumber: 'Q-2026-000001', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'sent',
    currencyCode: 'USD', issueDate: '2026-06-01', expiryDate: null, subtotal: '100.00', taxRate: null,
    taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '100.00', billToName: null, introNotes: null,
    terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
    convertedAt: null, convertedInvoiceId: null, sentAt: '2026-06-01', viewedAt: null,
    createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-02T00:00:00Z',
    ...over,
  },
  // A quote with no customer-visible line is "empty" and Send stays disabled,
  // so the composer tests need one real line.
  blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
  lines: [{
    id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
    catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
    name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
    customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
    billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
  }],
  ...rest,
});

/** Header variant folds Revise into the ⋯ overflow menu, same as Clone. */
function openMenu() {
  fireEvent.click(screen.getByTestId('quote-actions-menu'));
}

describe('QuoteActions — Revise', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organizations = [{ id: 'org-1', name: 'Acme' }];
    mocks.can.mockImplementation((_r: string, action: string) => action === 'read' || action === 'write');
    mocks.runAction.mockImplementation(async ({ request }: { request: () => Promise<unknown> }) => {
      await request();
      return { data: { id: 'q-2' } };
    });
    mocks.reviseQuote.mockResolvedValue(new Response(JSON.stringify({ data: { id: 'q-2' } }), { status: 200 }));
  });

  // A revision REPLACES a live proposal, so it is offered exactly on the
  // statuses the server will supersede — never on a draft (nothing to replace),
  // and never on a settled or already-retired quote.
  it.each(['sent', 'viewed', 'declined', 'expired'])('offers Revise on a %s quote', (status) => {
    render(<QuoteActions detail={detailWith({ status: status as never })} variant="header" />);
    openMenu();
    expect(screen.getByTestId('quote-revise')).toBeInTheDocument();
  });

  it.each(['draft', 'accepted', 'converted', 'superseded'])('does not offer Revise on a %s quote', (status) => {
    render(<QuoteActions detail={detailWith({ status: status as never })} variant="header" />);
    openMenu();
    expect(screen.queryByTestId('quote-revise')).not.toBeInTheDocument();
  });

  it('does not offer Revise to a read-only viewer', () => {
    mocks.can.mockImplementation((_r: string, action: string) => action === 'read');
    render(<QuoteActions detail={detailWith()} variant="header" />);
    // A read-only viewer gets no write actions at all, so the overflow menu
    // itself is absent — assert directly rather than trying to open it.
    expect(screen.queryByTestId('quote-actions-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quote-revise')).not.toBeInTheDocument();
  });

  it('creates the revision and opens the new draft, the same navigation seam clone uses', async () => {
    render(<QuoteActions detail={detailWith()} variant="header" />);
    openMenu();
    fireEvent.click(screen.getByTestId('quote-revise'));

    await waitFor(() => expect(mocks.reviseQuote).toHaveBeenCalledWith('q-1'));
    expect(mocks.runAction).toHaveBeenCalledWith(expect.objectContaining({
      successMessage: expect.any(String),
      errorFallback: expect.any(String),
    }));
    expect(mocks.navigateTo).toHaveBeenCalledWith('/billing/quotes/q-2');
  });

  // The server allows only ONE open revision per quote. Without this branch the
  // tech gets a bare 409 and no way to reach the draft that is blocking them.
  it('recovers from REVISION_IN_PROGRESS by opening the existing revision', async () => {
    mocks.runAction.mockRejectedValue(new ActionError(
      'A revision of this quote is already in progress',
      409,
      'REVISION_IN_PROGRESS',
      { error: 'x', code: 'REVISION_IN_PROGRESS', meta: { revisionQuoteId: 'q-existing' } },
    ));

    render(<QuoteActions detail={detailWith()} variant="header" />);
    openMenu();
    fireEvent.click(screen.getByTestId('quote-revise'));

    await waitFor(() => expect(mocks.navigateTo).toHaveBeenCalledWith('/billing/quotes/q-existing'));
  });

  // A 409 without the id is not actionable — it must not navigate to undefined.
  it('does not navigate when REVISION_IN_PROGRESS carries no revision id', async () => {
    mocks.runAction.mockRejectedValue(new ActionError(
      'A revision of this quote is already in progress', 409, 'REVISION_IN_PROGRESS',
      { error: 'x', code: 'REVISION_IN_PROGRESS' },
    ));

    render(<QuoteActions detail={detailWith()} variant="header" />);
    openMenu();
    fireEvent.click(screen.getByTestId('quote-revise'));

    // runAction is mocked at the seam, so the inner request never runs; what
    // matters is that an id-less 409 navigates NOWHERE rather than to
    // /billing/quotes/undefined.
    await waitFor(() => expect(mocks.runAction).toHaveBeenCalled());
    expect(mocks.navigateTo).not.toHaveBeenCalled();
  });
});

describe('QuoteActions — sending a revision', () => {
  beforeEach(() => {
    mocks.can.mockImplementation((_r: string, action: string) => action === 'read' || action === 'write' || action === 'send');
  });

  const revisionDraft = () => detailWith(
    { status: 'draft', revisionOfQuoteId: 'q-0', revisionNumber: 2 },
    { revisionOf: { id: 'q-0', quoteNumber: 'Q-2026-000001', recipients: ['buyer@customer.test'] } },
  );

  // The consequence of this send — the original is retired and the customer's
  // existing link stops working — appears nowhere else in the dialog, and it
  // cannot be undone once the send commits.
  it('warns in the send composer that the original will be replaced', async () => {
    render(<QuoteActions detail={revisionDraft()} variant="header" />);
    fireEvent.click(screen.getByTestId('quote-send'));

    await waitFor(() => expect(screen.getByTestId('quote-send-revision-warning')).toBeInTheDocument());
    expect(screen.getByTestId('quote-send-revision-warning')).toHaveTextContent('Q-2026-000001');
  });

  it('does not warn when the draft is not a revision', async () => {
    render(<QuoteActions detail={detailWith({ status: 'draft' })} variant="header" />);
    fireEvent.click(screen.getByTestId('quote-send'));

    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-send-revision-warning')).not.toBeInTheDocument();
  });

  // Display honesty: the server falls back to the parent's recipients anyway,
  // so an empty To would misrepresent who is about to receive this.
  it('prefills To with the addresses the original went to', async () => {
    render(<QuoteActions detail={revisionDraft()} variant="header" />);
    fireEvent.click(screen.getByTestId('quote-send'));

    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('buyer@customer.test'));
  });
});
