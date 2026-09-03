import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteDetail from './QuoteDetail';
import * as quotesApi from '../../../lib/api/quotes';
import type { QuoteDetail as QuoteDetailData, QuoteStatus } from './quoteTypes';

// #4416 — the draft-only atomic change-currency op (#3774,
// changeQuoteCurrency in quoteService.ts) has been reachable server-side
// since multi-currency wave 2, but only ContractDetail ever grew a dialog for
// it. These tests pin the ported behaviour:
//   - the action is offered only on a DRAFT quote, gated on quotes:write;
//   - a success posts exactly the confirmed payload and reloads the quote;
//   - a 409 CURRENCY_LOCKED renders inline (in ADDITION to runAction's own
//     toast) and keeps the dialog open — never a silent no-op.

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) =>
      selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

vi.mock('../../../lib/api/quotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api/quotes')>();
  return { ...actual, changeQuoteCurrency: vi.fn() };
});

const resp = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function detail(status: QuoteStatus, currencyCode = 'USD'): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status,
      currencyCode, issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', billToName: 'Acme', introNotes: null, terms: null,
      termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [],
    lines: [],
  };
}

const write = [{ resource: 'quotes', action: 'write' }];

async function openDialog() {
  await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('quote-currency-open'));
  await screen.findByTestId('quote-currency-dialog');
}

async function confirmWith(mode: 'clear' | 'reprice', currency = 'EUR') {
  fireEvent.change(screen.getByTestId('quote-currency-select'), { target: { value: currency } });
  fireEvent.click(screen.getByTestId(`quote-currency-mode-${mode}`));
  fireEvent.click(screen.getByTestId('quote-currency-confirm-check'));
  fireEvent.click(screen.getByTestId('quote-currency-submit'));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = write;
  (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: { id: 'q-1' } }));
});

describe('QuoteDetail — draft currency change (#4416)', () => {
  it('shows the action on a DRAFT quote with quotes:write', async () => {
    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.getByTestId('quote-currency-open')).toBeInTheDocument();
  });

  it('hides the action without quotes:write', async () => {
    state.permissions = [{ resource: 'quotes', action: 'read' }];
    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-currency-open')).not.toBeInTheDocument();
  });

  it('does not offer the action on a non-draft (sent) quote', async () => {
    render(<QuoteDetail detail={detail('sent')} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('quote-detail')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-currency-open')).not.toBeInTheDocument();
  });

  it('keeps submit disabled until a mode is chosen, confirmed, and the currency differs', async () => {
    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    const submit = () => screen.getByTestId('quote-currency-submit') as HTMLButtonElement;

    expect(submit().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('quote-currency-select'), { target: { value: 'EUR' } });
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('quote-currency-mode-clear'));
    expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('quote-currency-confirm-check'));
    expect(submit().disabled).toBe(false);

    fireEvent.change(screen.getByTestId('quote-currency-select'), { target: { value: 'USD' } });
    expect(submit().disabled).toBe(true);
  });

  it('posts exactly the confirmed payload and reloads the quote on success', async () => {
    const onChanged = vi.fn();
    render(<QuoteDetail detail={detail('draft')} onChanged={onChanged} />);
    await openDialog();
    await confirmWith('reprice', 'EUR');

    await waitFor(() => expect(quotesApi.changeQuoteCurrency).toHaveBeenCalledTimes(1));
    expect(quotesApi.changeQuoteCurrency).toHaveBeenCalledWith('q-1', { currencyCode: 'EUR', reprice: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('quote-currency-dialog')).not.toBeInTheDocument());
  });

  it('sends clearLines (not reprice) when the operator chooses to clear the lines', async () => {
    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear', 'JPY');

    await waitFor(() => expect(quotesApi.changeQuoteCurrency).toHaveBeenCalledWith('q-1', {
      currencyCode: 'JPY', clearLines: true,
    }));
  });

  it('shows a 409 CURRENCY_LOCKED message inline and keeps the dialog open', async () => {
    (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(resp({
      error: 'Quote has 2 line(s) priced in USD — pass clearLines to remove them, or delete the draft',
      code: 'CURRENCY_LOCKED',
    }, 409));

    const onChanged = vi.fn();
    render(<QuoteDetail detail={detail('draft')} onChanged={onChanged} />);
    await openDialog();
    await confirmWith('clear');

    const error = await screen.findByTestId('quote-currency-error');
    expect(error).toHaveTextContent(/pass clearLines/i);
    expect(screen.getByTestId('quote-currency-dialog')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('replaces a stale inline error with the new one on a second failed retry', async () => {
    // Two DIFFERENT failures back to back: if the component ever stopped
    // resetting currencyError before the retry request, the first message
    // could linger (e.g. a stale closure, or a guard that only sets the error
    // when it was previously null) and this would still show "first lock
    // reason" after the second attempt.
    (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      resp({ error: 'first lock reason', code: 'CURRENCY_LOCKED' }, 409),
    );
    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear');
    expect(await screen.findByTestId('quote-currency-error')).toHaveTextContent('first lock reason');

    (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      resp({ error: 'second lock reason', code: 'CURRENCY_LOCKED' }, 409),
    );
    fireEvent.click(screen.getByTestId('quote-currency-submit'));
    await waitFor(() => {
      const error = screen.getByTestId('quote-currency-error');
      expect(error).toHaveTextContent('second lock reason');
      expect(error).not.toHaveTextContent('first lock reason');
    });
    expect(screen.getByTestId('quote-currency-dialog')).toBeInTheDocument();
  });

  it('clears a previous inline error and reloads the quote on a successful retry', async () => {
    (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      resp({ error: 'locked', code: 'CURRENCY_LOCKED' }, 409),
    );
    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    await confirmWith('clear');
    await screen.findByTestId('quote-currency-error');

    (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockResolvedValue(resp({ data: { id: 'q-1' } }));
    fireEvent.click(screen.getByTestId('quote-currency-submit'));
    await waitFor(() => expect(screen.queryByTestId('quote-currency-dialog')).not.toBeInTheDocument());
  });

  it('disables submit while the change-currency request is in flight (busy cue)', async () => {
    // Mirrors the InvoiceEditor "disables the notes textarea while its own
    // save is in flight" pattern: hold the request open with a deferred
    // Promise so the busy window is actually observable, not just inferred
    // from the eventual settled state.
    let releaseRequest: (v: Response) => void = () => {};
    (quotesApi.changeQuoteCurrency as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<Response>((resolve) => { releaseRequest = resolve; }),
    );

    render(<QuoteDetail detail={detail('draft')} onChanged={vi.fn()} />);
    await openDialog();
    fireEvent.change(screen.getByTestId('quote-currency-select'), { target: { value: 'EUR' } });
    fireEvent.click(screen.getByTestId('quote-currency-mode-clear'));
    fireEvent.click(screen.getByTestId('quote-currency-confirm-check'));
    fireEvent.click(screen.getByTestId('quote-currency-submit'));

    await waitFor(() => expect(screen.getByTestId('quote-currency-submit')).toBeDisabled());
    releaseRequest(resp({ data: { id: 'q-1' } }));
    await waitFor(() => expect(screen.queryByTestId('quote-currency-dialog')).not.toBeInTheDocument());
  });
});
