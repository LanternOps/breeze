import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuoteActions from './QuoteActions';
import { SHOW_INTERNAL_MARGIN_KEY } from '../billingUi';
import { fetchWithAuth } from '../../../stores/auth';
import type { QuoteDetail as QuoteDetailData } from './quoteTypes';

// #8232: the send composer warns (without blocking) when product-like lines
// have no part number or SKU and so will be left out of the parts order.
const state = vi.hoisted(() => ({ canSeeMargin: true }));
vi.mock('../../../lib/permissions', () => ({
  usePermissions: () => ({ can: (resource: string, action: string) => {
    if (resource === 'quotes' && action === 'read') return state.canSeeMargin;
    return true; // quotes:send / quotes:write etc. stay granted for these tests
  } }),
}));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { organizations: unknown[] }) => unknown) => sel({ organizations: [] }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () =>
    ({ ok: true, json: async () => ({ billingContact: { email: 'ap@customer.example' } }) }) as unknown as Response),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
const scheduleQuoteSendMock = vi.fn().mockResolvedValue({ data: { sendScheduledAt: '2099-01-01T00:00:00Z' } });
vi.mock('../../../lib/api/quotes', () => ({
  sendQuote: vi.fn(),
  scheduleQuoteSend: (...args: unknown[]) => scheduleQuoteSendMock(...args),
  cancelScheduledSend: vi.fn(),
  deleteQuote: vi.fn(),
  quotePdfUrl: vi.fn().mockReturnValue('/quotes/q-1/pdf'),
}));

function draft(lines: QuoteDetailData['lines']): QuoteDetailData {
  return {
    quote: {
      id: 'q-1', quoteNumber: null, partnerId: 'p-1', orgId: 'org-1', siteId: null, status: 'draft',
      currencyCode: 'USD', issueDate: null, expiryDate: null, subtotal: '0.00', taxRate: null,
      taxTotal: '0.00', total: '0.00', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00', dueOnAcceptanceTotal: '0.00', billToName: 'Acme Inc.', introNotes: null,
      terms: null, termsAndConditions: null, sellerSnapshot: null, acceptedAt: null, declinedAt: null,
      convertedAt: null, convertedInvoiceId: null, sentAt: null, viewedAt: null,
      createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    },
    blocks: [{ id: 'b-1', quoteId: 'q-1', orgId: 'org-1', blockType: 'line_items', content: {}, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z' }],
    lines,
  };
}

const lineMissingCost: QuoteDetailData['lines'][number] = {
  id: 'l-1', quoteId: 'q-1', blockId: 'b-1', orgId: 'org-1', sourceType: 'manual',
  catalogItemId: null, parentLineId: null, unitCost: null, sku: null, partNumber: null,
  name: 'Support', description: null, quantity: '1.00', unitPrice: '100.00', taxable: false,
  customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
  billingFrequency: null, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
};

const lineWithCost: QuoteDetailData['lines'][number] = {
  ...lineMissingCost, id: 'l-2', unitCost: '40.00',
};

beforeEach(() => {
  vi.clearAllMocks();
  scheduleQuoteSendMock.mockResolvedValue({ data: { sendScheduledAt: '2099-01-01T00:00:00Z' } });
  state.canSeeMargin = true;
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    ({ ok: true, json: async () => ({ billingContact: { email: 'ap@customer.example' } }) }) as unknown as Response);
  localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
});

const hardwareNoPn: QuoteDetailData['lines'][number] = {
  ...lineWithCost, id: 'l-hw', sourceType: 'catalog', itemType: 'hardware', name: 'iPad', description: 'MD3Y4LL/A',
};
const manualProductNoPn: QuoteDetailData['lines'][number] = { ...lineWithCost, id: 'l-cable', name: 'Cable' };
const hardwareWithPn: QuoteDetailData['lines'][number] = { ...hardwareNoPn, id: 'l-hw2', partNumber: 'MD3Y4LL/A' };
const serviceWithCost: QuoteDetailData['lines'][number] = { ...lineWithCost, id: 'l-svc', itemType: 'service' };

async function openSend(lines: QuoteDetailData['lines']) {
  render(<QuoteActions detail={draft(lines)} onChanged={vi.fn()} variant="rail" />);
  fireEvent.click(screen.getByTestId('quote-send'));
  await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());
}

describe('QuoteActions — send-time missing part number warning (#8232)', () => {
  it('counts product-like lines without a part number and offers "Send anyway"', async () => {
    await openSend([hardwareNoPn, manualProductNoPn, hardwareWithPn, serviceWithCost, lineMissingCost]);
    expect(screen.getByTestId('quote-send-no-part-number-warning')).toHaveTextContent(
      "2 product lines have no part number and won't be added to the parts order.",
    );
    const confirm = screen.getByTestId('quote-send-confirm');
    expect(confirm).toHaveTextContent('Send anyway');
    expect(confirm).not.toBeDisabled();
  });

  it('uses the singular form for one line', async () => {
    await openSend([hardwareNoPn]);
    expect(screen.getByTestId('quote-send-no-part-number-warning')).toHaveTextContent(
      "1 product line has no part number and won't be added to the parts order.",
    );
  });

  it('is absent (and the button reads "Send proposal") when every product line has an identifier', async () => {
    await openSend([hardwareWithPn, serviceWithCost, lineMissingCost]);
    expect(screen.queryByTestId('quote-send-no-part-number-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-send-confirm')).toHaveTextContent('Send proposal');
  });

  it('shows even with cost & margin hidden — a part number is not margin data', async () => {
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '0');
    state.canSeeMargin = false;
    await openSend([hardwareNoPn]);
    expect(screen.getByTestId('quote-send-no-part-number-warning')).toBeInTheDocument();
  });

  it('is absent when re-sending — the lines were already sent', async () => {
    const detail = draft([hardwareNoPn]);
    detail.quote = { ...detail.quote, status: 'sent', quoteNumber: 'Q-1', sentAt: '2026-06-02T00:00:00Z' };
    render(<QuoteActions detail={detail} onChanged={vi.fn()} variant="rail" />);
    fireEvent.click(screen.getByTestId('quote-resend'));
    await waitFor(() => expect(screen.getByTestId('quote-send-confirm')).toBeInTheDocument());
    expect(screen.queryByTestId('quote-send-no-part-number-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-send-confirm')).not.toHaveTextContent('Send anyway');
  });

  it('"Send anyway" still sends', async () => {
    await openSend([hardwareNoPn]);
    await waitFor(() => expect(screen.getByTestId('quote-send-to')).toHaveValue('ap@customer.example'));
    fireEvent.click(screen.getByTestId('quote-send-confirm'));
    await waitFor(() => expect(scheduleQuoteSendMock).toHaveBeenCalledWith('q-1', expect.objectContaining({ to: ['ap@customer.example'] })));
  });
});
