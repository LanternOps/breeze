// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PublicInvoiceView from './PublicInvoiceView';
import { portalApi, type PublicInvoiceDetail } from '@/lib/api';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const data: PublicInvoiceDetail = {
  invoice: { id: '11111111-1111-4111-8111-111111111111', invoiceNumber: 'INV-1', status: 'sent', currencyCode: 'USD',
    total: '100.00', subtotal: '100.00', taxTotal: '0.00', amountPaid: '0.00', balance: '100.00' },
  lines: [], chargeNow: { amount: '100.00', isDeposit: false }, payable: true,
  branding: { partnerName: 'Example MSP', contactEmail: null, logoUrl: null, primaryColor: null, theme: 'classic', pageSize: 'letter' },
  autopay: { eligible: true, consentText: 'I authorize Example MSP.', consentVersion: '2026-10-01', disclosureHash: 'a'.repeat(64) },
};
it('shows unticked consent only when the server says this invoice can save a card', () => {
  const view = render(<PublicInvoiceView token="token" initial={data} />);
  expect((screen.getByTestId('autopay-save-card') as HTMLInputElement).checked).toBe(false);
  view.unmount();
  render(<PublicInvoiceView token="other-token" initial={{ ...data, autopay: null }} />);
  expect(screen.queryByTestId('autopay-save-card')).toBeNull();
});

for (const consent of ['untouched', 'accepted', 'withdrawn'] as const) {
  it(`submits public payment with ${consent} consent`, async () => {
    const pay = vi.spyOn(portalApi, 'payPublicInvoice').mockResolvedValue({ error: 'Payment unavailable', statusCode: 409 });
    render(<PublicInvoiceView token="token" initial={data} />);
    if (consent !== 'untouched') fireEvent.click(screen.getByTestId('autopay-save-card'));
    if (consent === 'withdrawn') fireEvent.click(screen.getByTestId('autopay-save-card'));
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    await vi.waitFor(() => expect(pay).toHaveBeenCalledWith('token', consent === 'accepted'
      ? { saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64) }
      : { saveForAutopay: false }));
    expect(screen.getByTestId('autopay-save-card-text')).toHaveTextContent(data.autopay!.consentText);
    expect(await screen.findByTestId('public-invoice-pay-error')).toHaveTextContent('Payment unavailable');
    expect(screen.getByTestId('public-invoice-pay')).not.toBeDisabled();
  });
}

it('does not offer consent for an ineligible or unpayable invoice', () => {
  const view = render(<PublicInvoiceView token="token" initial={{ ...data, autopay: { ...data.autopay!, eligible: false } }} />);
  expect(screen.queryByTestId('autopay-save-card')).toBeNull();
  view.unmount();
  render(<PublicInvoiceView token="token" initial={{ ...data, payable: false }} />);
  expect(screen.queryByTestId('autopay-save-card')).toBeNull();
});

it.each(['throw', 'invalid-url'] as const)('surfaces %s failures and re-enables payment', async failure => {
  const pay = vi.spyOn(portalApi, 'payPublicInvoice');
  if (failure === 'throw') pay.mockRejectedValue(new Error('offline'));
  else pay.mockResolvedValue({ data: { data: { url: 'https://example.com/' } } });
  render(<PublicInvoiceView token="token" initial={data} />);
  fireEvent.click(screen.getByTestId('public-invoice-pay'));
  expect(await screen.findByTestId('public-invoice-pay-error')).toHaveTextContent('Could not start payment. Please try again.');
  expect(screen.getByTestId('public-invoice-pay')).not.toBeDisabled();
});
