// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QuoteDetail } from '@/lib/api';

const { acceptQuote, getInvoice } = vi.hoisted(() => ({ acceptQuote: vi.fn(), getInvoice: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  portalApi: { acceptQuote, getInvoice },
}));

import { QuoteDetailView } from './QuoteDetailView';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DETAIL = {
  quote: {
    id: '22222222-2222-4222-8222-222222222222',
    quoteNumber: 'Q-1',
    title: 'Managed Services',
    status: 'sent',
    currencyCode: 'USD',
    total: '300.00',
    oneTimeTotal: '300.00',
    dueOnAcceptanceTotal: '300.00',
    depositDueTotal: '90.00',
  },
  blocks: [],
  lines: [],
  branding: { partnerName: 'Lantern IT', logoUrl: null, primaryColor: '#123456' },
} as unknown as QuoteDetail;

async function acceptQuoteFlow(onlinePaymentAvailable: boolean | undefined, invoiceResult?: unknown) {
  acceptQuote.mockResolvedValue({ data: { data: { invoiceId: 'inv-1', status: 'converted' } } });
  if (invoiceResult === 'reject') getInvoice.mockRejectedValue(new Error('boom'));
  else getInvoice.mockResolvedValue(invoiceResult ?? { data: { onlinePaymentAvailable } });
  render(<QuoteDetailView detail={DETAIL} />);
  fireEvent.change(screen.getByTestId('quote-signer'), { target: { value: 'Pat Customer' } });
  const agree = screen.queryByTestId('quote-agree');
  if (agree) fireEvent.click(agree);
  fireEvent.click(screen.getByTestId('quote-accept'));
  await screen.findByTestId('quote-accept-success');
}

describe('portal quote accepted state — online payment gate (#9264)', () => {
  it('hides Pay deposit and explains offline payment when online payment is unavailable', async () => {
    await acceptQuoteFlow(false);
    await waitFor(() => expect(getInvoice).toHaveBeenCalledWith('inv-1'));
    await screen.findByTestId('quote-pay-offline');
    expect(screen.queryByTestId('quote-pay')).toBeNull();
    expect(screen.getByTestId('quote-accepted-invoice').textContent).toBe('View invoice');
    expect(screen.getByTestId('quote-pay-offline').textContent)
      .toContain("Online payment isn't available for this invoice. Please contact Lantern IT to pay.");
  });

  it('shows Pay deposit when online payment is available', async () => {
    await acceptQuoteFlow(true);
    expect((await screen.findByTestId('quote-pay')).textContent).toBe('Pay deposit $90.00');
    expect(screen.queryByTestId('quote-pay-offline')).toBeNull();
  });

  it.each([
    ['availability absent', undefined, undefined],
    ['lookup returns an error', undefined, { error: 'Network error' }],
    ['lookup rejects', undefined, 'reject'],
  ])('keeps Pay deposit and still reaches the accepted state when %s', async (_n, avail, result) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await acceptQuoteFlow(avail, result);
    expect((await screen.findByTestId('quote-pay')).textContent).toBe('Pay deposit $90.00');
    expect(screen.queryByTestId('quote-pay-offline')).toBeNull();
  });
});
