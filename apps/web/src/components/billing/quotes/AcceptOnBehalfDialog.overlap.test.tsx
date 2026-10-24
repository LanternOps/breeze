import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AcceptOnBehalfDialog from './AcceptOnBehalfDialog';
import type { Quote, QuoteLine } from './quoteTypes';

// #9303: an accept creates a new draft contract per recurring cadence and never
// looks at the org's existing contracts. When the org already had one on the
// same cadence, the tech must hear about it right after the accept — before
// activating both and billing the customer twice.

vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...(args as [])),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));

const okRes = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

const quote = {
  id: 'q-1', quoteNumber: 'Q-1', partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'sent',
  currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '500.00', taxRate: null,
  taxTotal: '0.00', total: '500.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '500.00',
  annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: 'Acme Inc.', introNotes: null,
  terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
  convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
  createdBy: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
} as unknown as Quote;

const lines: QuoteLine[] = [{
  id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Managed services', description: null, quantity: '1.00', unitPrice: '500.00', taxable: false,
  customerVisible: true, lineTotal: '500.00', recurrence: 'monthly', termMonths: null,
  billingFrequency: null, sortOrder: 0, createdAt: '2026-10-01T00:00:00Z',
} as unknown as QuoteLine];

function acceptResponse(overlappingContracts: unknown[]) {
  return {
    data: {
      quote: { ...quote, status: 'converted' }, invoiceId: 'inv-1', invoiceIssued: false, invoiceNumber: null,
      contractIds: ['ct-new'], overlappingContracts, payUrl: null,
    },
  };
}

function renderAndSubmit(onAccepted = vi.fn()) {
  render(<AcceptOnBehalfDialog open onClose={vi.fn()} quote={quote} lines={lines} recipients={[]} onAccepted={onAccepted} />);
  fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'Call 10-19' } });
  fireEvent.change(screen.getByTestId('accept-on-behalf-signer-name'), { target: { value: 'Dana Buyer' } });
  fireEvent.click(screen.getByTestId('accept-on-behalf-submit'));
  return onAccepted;
}

describe('AcceptOnBehalfDialog — existing same-cadence contract notice (#9303)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the post-accept notice linking the new and the existing contract', async () => {
    fetchWithAuth.mockResolvedValue(okRes(acceptResponse([
      { id: 'ct-hand', name: 'Hand-built MSA', status: 'draft', intervalMonths: 1 },
    ])));
    const onAccepted = renderAndSubmit();

    const notice = await screen.findByTestId('quote-accept-overlap-notice');
    expect(within(notice).getByTestId('quote-accept-overlap-existing-ct-hand')).toHaveAttribute('href', '/contracts/ct-hand');
    expect(within(notice).getByTestId('quote-accept-overlap-new-ct-new')).toHaveAttribute('href', '/contracts/ct-new');
    expect(notice).toHaveTextContent('Hand-built MSA');
    // The workspace reload waits until the tech has read it.
    expect(onAccepted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('quote-accept-overlap-done'));
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it('Escape on the notice also reloads (the accept already happened), never the plain close', async () => {
    fetchWithAuth.mockResolvedValue(okRes(acceptResponse([
      { id: 'ct-hand', name: 'Hand-built MSA', status: 'draft', intervalMonths: 1 },
    ])));
    const onClose = vi.fn();
    const onAccepted = vi.fn();
    render(<AcceptOnBehalfDialog open onClose={onClose} quote={quote} lines={lines} recipients={[]} onAccepted={onAccepted} />);
    fireEvent.change(screen.getByTestId('accept-on-behalf-reference'), { target: { value: 'Call 10-19' } });
    fireEvent.change(screen.getByTestId('accept-on-behalf-signer-name'), { target: { value: 'Dana Buyer' } });
    fireEvent.click(screen.getByTestId('accept-on-behalf-submit'));
    const notice = await screen.findByTestId('quote-accept-overlap-notice');

    // Dialog handles Escape on its backdrop; a keydown inside bubbles to it.
    fireEvent.keyDown(notice, { key: 'Escape' });
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes straight away when there is no existing same-cadence contract', async () => {
    fetchWithAuth.mockResolvedValue(okRes(acceptResponse([])));
    const onAccepted = renderAndSubmit();
    await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('quote-accept-overlap-notice')).not.toBeInTheDocument();
  });
});
