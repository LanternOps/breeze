import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AcceptOnBehalfDialog from './AcceptOnBehalfDialog';
import type { Quote, QuoteLine } from './quoteTypes';

// #6637: accepting a DRAFT on behalf runs the same send-time gates as a real
// Send (`assertQuoteSendGates`), so the same two codes it has always thrown
// can come back on this dialog's submit: 422 CONTRACT_VARIABLES_UNRESOLVED and
// 409 DEPOSIT_INVALID. Before this fix the dialog showed the server's raw
// English message verbatim via runAction's generic error toast.
//
// This suite deliberately does NOT mock `runAction` (contrast
// QuoteActions.acceptOnBehalf.test.tsx's passthrough mock) — it drives the
// real error-parsing path (extractApiError → the `friendly` hook →
// showToast) against a mocked HTTP response, the same pattern
// QuoteEditor.contractblock.test.tsx uses for the sibling 422 on Send.

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...(args as [])),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));

function errRes(status: number, body: unknown): Response {
  return { ok: false, status, statusText: 'Error', json: async () => body } as unknown as Response;
}

const quote = {
  id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '100.00', taxRate: null,
  taxTotal: '0.00', total: '100.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '100.00', billToName: 'Acme Inc.', introNotes: null,
  terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as unknown as Quote;

const lines: QuoteLine[] = [{
  id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
  customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
  billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
} as unknown as QuoteLine];

async function fillAndSubmit(): Promise<void> {
  render(
    <AcceptOnBehalfDialog
      open
      onClose={vi.fn()}
      quote={quote}
      lines={lines}
      recipients={[]}
      onAccepted={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'PO 1' } });
  fireEvent.change(screen.getByTestId('accept-on-behalf-signer-name'), { target: { value: 'Dana Buyer' } });
  fireEvent.click(screen.getByTestId('accept-on-behalf-submit'));
  await waitFor(() => expect(showToast).toHaveBeenCalled());
}

describe('AcceptOnBehalfDialog — friendly send-gate error copy (#6637)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/orgs/partners/me')) {
        return { ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: false }) } as unknown as Response;
      }
      return errRes(422, { error: 'unset', code: 'UNSET' });
    });
  });

  it('lists the unresolved variable names from a 422 CONTRACT_VARIABLES_UNRESOLVED', async () => {
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/orgs/partners/me')) {
        return { ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: false }) } as unknown as Response;
      }
      return errRes(422, {
        error: 'Contract variables unresolved: client.signatory, initial_term',
        code: 'CONTRACT_VARIABLES_UNRESOLVED',
      });
    });
    await fillAndSubmit();
    const toasted = showToast.mock.calls.at(-1)?.[0] as { message: string };
    expect(toasted.message).toContain('client.signatory, initial_term');
    expect(toasted.message).not.toBe('Contract variables unresolved: client.signatory, initial_term');
    expect(toasted.message.toLowerCase()).not.toContain('cannot');
  });

  it('falls back to generic contract-unresolved copy when no names are parseable', async () => {
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/orgs/partners/me')) {
        return { ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: false }) } as unknown as Response;
      }
      return errRes(422, { error: 'unresolved contract variables', code: 'CONTRACT_VARIABLES_UNRESOLVED' });
    });
    await fillAndSubmit();
    const toasted = showToast.mock.calls.at(-1)?.[0] as { message: string };
    expect(toasted.message).toBe('This quote’s contract has unresolved variables. Close this dialog, fill them in below, then try again.'.replace('’', '\''));
  });

  it('shows friendly copy for a 409 DEPOSIT_INVALID', async () => {
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/orgs/partners/me')) {
        return { ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: false }) } as unknown as Response;
      }
      return errRes(409, {
        error: 'Cannot accept: Deposit must be less than the amount due on acceptance — remove the deposit instead',
        code: 'DEPOSIT_INVALID',
      });
    });
    await fillAndSubmit();
    const toasted = showToast.mock.calls.at(-1)?.[0] as { message: string };
    expect(toasted.message).toBe("This quote's deposit can't be collected as configured. Close this dialog, fix the deposit settings below, then try again.");
    expect(toasted.message.toLowerCase()).not.toContain('cannot accept');
  });

  it('leaves an unrelated error code to the server message (no friendly override)', async () => {
    fetchWithAuth.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/orgs/partners/me')) {
        return { ok: true, status: 200, json: async () => ({ autoEmailInvoiceOnQuoteAccept: false }) } as unknown as Response;
      }
      return errRes(409, { error: 'Cannot accept a quote in status converted', code: 'INVALID_STATE' });
    });
    await fillAndSubmit();
    const toasted = showToast.mock.calls.at(-1)?.[0] as { message: string };
    expect(toasted.message).toBe('Cannot accept a quote in status converted');
  });
});
