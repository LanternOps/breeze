// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import { portalApi, type PublicInvoiceDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicInvoiceView } from './PublicInvoiceView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function detail(overrides: Partial<PublicInvoiceDetail> = {}): PublicInvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: 'INV-2026-0001', status: 'sent', currencyCode: 'USD',
      issueDate: '2026-08-01', dueDate: '2026-08-31', total: '100.00', amountPaid: '0.00',
      balance: '100.00', depositDue: null, subtotal: '100.00', taxTotal: '0.00', taxRate: null,
    },
    lines: [],
    chargeNow: { amount: '100.00', isDeposit: false },
    payable: true,
    branding: { partnerName: 'Lantern MSP', contactEmail: null, logoUrl: null, primaryColor: null, theme: 'classic', pageSize: 'letter' },
    ...overrides,
  } as PublicInvoiceDetail;
}


it('loads the server bank offer and starts setup only after consent',async()=>{
 const offer={available:true,principal:'100.00',fee:'0.00',currency:'USD' as const,consentText:'Authorize bank payment.',disclosureHash:'a'.repeat(64),methodStatus:null};
 vi.spyOn(portalApi,'getPublicInvoice').mockResolvedValue({data:{data:detail({bankAutopay:offer})}});
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:{url:'https://checkout.stripe.com/c/setup/example'}}),{status:200,headers:{'Content-Type':'application/json'}}));
 render(<PublicInvoiceView token="token-1"/>);
 fireEvent.click(await screen.findByTestId('autopay-option-bank'));
 const button=screen.getByTestId('autopay-bank-pay');expect((button as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(button);
 await waitFor(()=>expect(fetch).toHaveBeenCalled());
 const payment=fetch.mock.calls.find(([url])=>String(url).endsWith('/invoices/public/token-1/pay'));
 expect(payment).toBeDefined();expect(JSON.parse(payment![1]!.body as string)).toMatchObject({phase:'setup',consentAccepted:true});
});

const cardOffer = {
  eligible: true, consentText: 'Authorize future card payments.',
  consentVersion: '2026-10-01', disclosureHash: 'c'.repeat(64),
};

describe('public invoice card consent', () => {
  it('pays by card once by default, with no consent asked', async () => {
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'Try again' });
    render(<PublicInvoiceView token="token-1" initial={detail({ autopay: cardOffer })} />);
    expect(screen.queryByTestId('autopay-save-card')).toBeNull();
    expect(screen.queryByText(cardOffer.consentText)).toBeNull();
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await waitFor(() => expect(pay).toHaveBeenCalledWith('token-1', { saveForAutopay: false }));
  });

  it('saving the card shows the authorization, starts unticked and sends it only once accepted', async () => {
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'Try again' });
    render(<PublicInvoiceView token="token-1" initial={detail({ autopay: cardOffer })} />);
    fireEvent.click(screen.getByTestId('autopay-option-card_save'));
    expect(screen.getByTestId('autopay-save-card-text')).toHaveTextContent(cardOffer.consentText);
    expect(screen.getByTestId('autopay-save-card')).not.toBeChecked();
    expect(screen.getByTestId('public-invoice-pay')).toBeDisabled();
    fireEvent.click(screen.getByTestId('autopay-save-card'));
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await waitFor(() => expect(pay).toHaveBeenCalledWith('token-1', {
      saveForAutopay: true, consentAccepted: true, disclosureHash: cardOffer.disclosureHash,
    }));
  });

  it('does not send consent after the customer unticks it and goes back to a one-off payment', async () => {
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'Try again' });
    render(<PublicInvoiceView token="token-1" initial={detail({ autopay: cardOffer })} />);
    fireEvent.click(screen.getByTestId('autopay-option-card_save'));
    fireEvent.click(screen.getByTestId('autopay-save-card'));
    fireEvent.click(screen.getByTestId('autopay-save-card'));
    expect(screen.getByTestId('public-invoice-pay')).toBeDisabled();
    fireEvent.click(screen.getByTestId('autopay-option-card'));
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await waitFor(() => expect(pay).toHaveBeenCalledWith('token-1', { saveForAutopay: false }));
  });

  it('an enrolled client is told how the invoice will be paid and offered no setup', async () => {
    const scheduled = { state: 'scheduled' as const, chargeDate: '2026-08-31', amount: '100.00', fee: '0.00', currency: 'USD',
      methodLabel: 'Visa credit card ending in 4242', methodType: 'card' as const, reason: null, paidAt: null, canPayNow: true };
    render(<PublicInvoiceView token="token-1" initial={detail({ autopay: null, autopayEnrolled: true, autopayStatus: scheduled,
      bankAutopay: { available: true, principal: '100.00', fee: '1.00', currency: 'USD', consentText: 'x', disclosureHash: 'a'.repeat(64), methodStatus: 'active' } })} />);
    expect(screen.getByText('This invoice will be paid automatically on August 31, 2026 with your Visa credit card ending in 4242.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent('Pay now instead');
  });

  it('keeps ordinary card payment available when consent is unavailable', async () => {
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'Try again' });
    render(<PublicInvoiceView token="token-1" initial={detail({ autopay: { ...cardOffer, eligible: false } })} />);
    expect(screen.queryByTestId('autopay-save-card')).toBeNull();
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await waitFor(() => expect(pay).toHaveBeenCalledWith('token-1', { saveForAutopay: false }));
  });

  it('surfaces a failed payment response and permits retry', async () => {
    vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'Payment unavailable', statusCode: 409 });
    render(<PublicInvoiceView token="token-1" initial={detail()} />);
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    expect(await screen.findByTestId('public-invoice-pay-error')).toHaveTextContent('Payment unavailable');
    expect(screen.getByTestId('public-invoice-pay')).toBeEnabled();
  });

  it('surfaces a rejected payment request and permits retry', async () => {
    vi.spyOn(portalApi, 'payPublicInvoice').mockRejectedValue(new Error('Network unavailable'));
    render(<PublicInvoiceView token="token-1" initial={detail()} />);
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    expect(await screen.findByTestId('public-invoice-pay-error')).toHaveTextContent('Could not start payment');
    expect(screen.getByTestId('public-invoice-pay')).toBeEnabled();
  });

  it('rejects an invalid checkout redirect', async () => {
    const before = window.location.href;
    vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ data: { data: { url: 'https://example.com/checkout' } } });
    render(<PublicInvoiceView token="token-1" initial={detail()} />);
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    expect(await screen.findByTestId('public-invoice-pay-error')).toHaveTextContent('Could not start payment');
    expect(window.location.href).toBe(before);
    expect(screen.getByTestId('public-invoice-pay')).toBeEnabled();
  });
});
