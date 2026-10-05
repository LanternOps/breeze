// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import { InvoicePaymentPanel, type InvoicePaymentPanelProps } from './InvoicePaymentPanel';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const saveOffer = { eligible: true, consentText: 'I authorize Example MSP to save this card and use it to pay future invoices automatically.', consentVersion: 'v', disclosureHash: 'c'.repeat(64) };
const bankOffer = { available: true, principal: '200.00', fee: '1.00', currency: 'USD' as const, consentText: 'I authorize a one-time bank payment.', disclosureHash: 'a'.repeat(64), methodStatus: null };
const scheduled = { state: 'scheduled' as const, chargeDate: '2026-11-04', amount: '50.00', fee: '1.50', currency: 'USD',
  methodLabel: 'Visa credit card ending in 4242', methodType: 'card' as const, reason: null, paidAt: null, canPayNow: true };
function panel(over: Partial<InvoicePaymentPanelProps> = {}) {
  const onPay = vi.fn();
  const props: InvoicePaymentPanelProps = { currency: 'USD', balance: '200.00', dueDate: '2026-11-04', status: 'sent', canPay: true,
    charge: { amount: '200.00', isDeposit: false }, bankTarget: { invoiceId: 'inv-1', publicToken: 'tok' }, partnerName: 'Example MSP',
    paying: false, onPay, payTestId: 'public-invoice-pay', processingTestId: 'public-invoice-collection-processing',
    release: vi.fn(), download: <button type="button">Download PDF</button>, ...over };
  render(<InvoicePaymentPanel {...props} />);
  return { onPay, props };
}

describe('not enrolled: one decision, consent only where it applies (D-4)', () => {
  it('leads with the balance and a plain card payment; no consent text by default', () => {
    const { onPay } = panel({ saveOffer, bankOffer });
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.getByText('Due November 4, 2026')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'How would you like to pay?' })).toBeInTheDocument();
    expect(screen.queryByText(saveOffer.consentText)).toBeNull();
    expect(screen.queryByText(bankOffer.consentText)).toBeNull();
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    expect(onPay).toHaveBeenCalledWith(false);
  });
  it('saving the card shows its authorization and needs the box ticked', () => {
    const { onPay } = panel({ saveOffer });
    fireEvent.click(screen.getByTestId('autopay-option-card_save'));
    expect(screen.getByTestId('autopay-save-card-text')).toHaveTextContent(saveOffer.consentText);
    const pay = screen.getByTestId('public-invoice-pay');
    expect(pay).toHaveTextContent('Pay $200.00 and save card');
    expect(pay).toBeDisabled();
    fireEvent.click(screen.getByTestId('autopay-save-card'));
    fireEvent.click(pay);
    expect(onPay).toHaveBeenCalledWith(true);
  });
  it('bank shows the bank flow in place of the card button', () => {
    panel({ bankOffer });
    expect(screen.getByText('$1.00 fee')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('autopay-option-bank'));
    expect(screen.getByTestId('autopay-bank-module')).toBeInTheDocument();
    expect(screen.getByTestId('autopay-bank-consent-text')).toHaveTextContent(bankOffer.consentText);
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
  });
  it('with no offers it is just a Pay button', () => {
    panel();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent('Pay $200.00');
  });
  it('an overdue invoice says when it was due', () => {
    panel({ status: 'overdue', dueDate: '2026-10-01' });
    expect(screen.getByText('Was due October 1, 2026')).toBeInTheDocument();
  });
});

describe('enrolled: the invoice says how it will be paid instead of offering setup again', () => {
  it('scheduled: date and method, amount and fee, and a quiet "Pay now instead"', () => {
    const { onPay } = panel({ autopayStatus: scheduled, autopayEnrolled: true, saveOffer, bankOffer });
    expect(screen.getByText('This invoice will be paid automatically on November 4, 2026 with your Visa credit card ending in 4242.')).toBeInTheDocument();
    expect(screen.getByText('up to $1.50')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(saveOffer.consentText)).toBeNull();
    const pay = screen.getByTestId('public-invoice-pay');
    expect(pay).toHaveTextContent('Pay now instead');
    fireEvent.click(pay);
    expect(onPay).toHaveBeenCalledWith(false);
  });
  it('awaiting notice promises the date by email', () => {
    panel({ autopayStatus: { ...scheduled, state: 'awaiting_notice', chargeDate: null }, autopayEnrolled: true });
    expect(screen.getByText(/We'll email you the payment date first/)).toBeInTheDocument();
  });
  it('processing: no action, no Pay', () => {
    panel({ autopayStatus: { ...scheduled, state: 'processing', canPayNow: false, methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' }, autopayEnrolled: true });
    expect(screen.getByTestId('public-invoice-collection-processing')).toHaveTextContent('$50.00 is being collected from your bank account ending in 6789');
    expect(screen.getByTestId('public-invoice-collection-processing')).toHaveTextContent('Bank payments usually take a few business days to clear.');
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
  });
  it('an older API still reports processing from collectionInProgress', () => {
    panel({ collectionInProgress: { amount: '100.00' } });
    expect(screen.getByTestId('public-invoice-collection-processing')).toHaveTextContent('$100.00');
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
  });
  it.each([
    [{ state: 'delayed', reason: 'method_not_usable' }, "We couldn't charge your saved Visa credit card ending in 4242", 'Pay $200.00'],
    [{ state: 'delayed', reason: 'pending_verification' }, 'once your bank account is verified', 'Pay now instead'],
    [{ state: 'delayed', reason: 'on_hold' }, 'is on hold at Example MSP', 'Pay now instead'],
    [{ state: 'retry_scheduled', chargeDate: '2026-11-07' }, "We'll try your Visa credit card ending in 4242 again on November 7, 2026", 'Pay now instead'],
    [{ state: 'failed' }, "Automatic payment didn't go through", 'Pay $200.00'],
    [{ state: 'skipped' }, 'You skipped the automatic payment', 'Pay $200.00'],
    [{ state: 'not_included', reason: 'enrolled_after_issue' }, 'issued before you set up automatic payments', 'Pay $200.00'],
    [{ state: 'not_included', reason: 'over_cap' }, 'over your automatic payment limit', 'Pay $200.00'],
  ] as const)('%j', (over, text, pay) => {
    panel({ autopayStatus: { ...scheduled, ...over } as never, autopayEnrolled: true });
    expect(screen.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent(pay);
  });
  it('the portal adds a way to fix an unusable method', () => {
    panel({ portal: true, autopayStatus: { ...scheduled, state: 'delayed', reason: 'method_not_usable' }, autopayEnrolled: true });
    expect(screen.getByRole('link', { name: 'Update your payment method' })).toBeInTheDocument();
  });
  it('paid automatically', () => {
    panel({ status: 'paid', canPay: false, balance: '0.00', autopayStatus: { ...scheduled, state: 'paid_automatically', paidAt: '2026-11-04T08:00:00Z' } });
    expect(screen.getByText(/Paid automatically on November 4, 2026 with your Visa credit card ending in 4242/)).toBeInTheDocument();
  });
  it('online payment unavailable says who to contact', () => {
    panel({ canPay: false, onlinePaymentUnavailable: true });
    expect(screen.getByText("Online payment isn't available for this invoice. Please contact Example MSP to pay.")).toBeInTheDocument();
  });
});

describe('waiting on the bank (3DS)', () => {
  const waiting = { autopayStatus: { ...scheduled, state: 'action_required' as const, canPayNow: false }, collectionInProgress: { amount: '50.00', actionRequired: true } };
  it('explains, offers the way out, and hides Pay until released', () => {
    panel(waiting);
    expect(screen.getByTestId('autopay-confirmation-notice')).toHaveTextContent('Your bank needs you to confirm this payment');
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
  });
  it('after release the success stays visible and Pay works, even when reloading the invoice fails', async () => {
    const release = vi.fn().mockResolvedValue({ data: { outcome: 'released' }, statusCode: 200 });
    const reload = vi.fn().mockResolvedValue(false);
    const { onPay } = panel({ ...waiting, release, reload });
    fireEvent.click(screen.getByTestId('autopay-confirmation-continue'));
    expect(await screen.findByTestId('autopay-confirmation-released')).toHaveTextContent('The automatic payment was canceled.');
    await waitFor(() => expect(screen.getByTestId('autopay-confirmation-released')).toHaveTextContent("We couldn't refresh the invoice"));
    expect(screen.queryByTestId('autopay-confirmation-notice')).toBeNull();
    fireEvent.click(screen.getByTestId('public-invoice-pay'));
    expect(onPay).toHaveBeenCalledWith(false);
  });
});
