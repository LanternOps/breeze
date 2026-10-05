// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import { InvoicePaymentPanel, type InvoicePaymentPanelProps } from './InvoicePaymentPanel';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const saveOffer = { eligible: true, consentText: 'I authorize Example MSP to save this card and use it to pay future invoices automatically.', consentVersion: 'v', disclosureHash: 'c'.repeat(64) };
const bankOffer = { available: true, principal: '200.00', fee: '1.00', currency: 'USD' as const, consentText: 'I authorize a one-time bank payment.', disclosureHash: 'a'.repeat(64), methodStatus: null, methodLabel: null };
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
  it('an overdue invoice says when it was due, in the overdue (brick) tone', () => {
    panel({ status: 'overdue', dueDate: '2026-10-01' });
    // V-25: DESIGN.md: overdue is brick, not amber.
    expect(screen.getByText('Was due October 1, 2026')).toHaveClass('text-destructive-on-tint');
  });
  // V-13: the panel leads with what the button charges.
  it('a deposit leads with the deposit, and every option says what it pays', () => {
    panel({ balance: '30.00', charge: { amount: '10.00', isDeposit: true }, bankOffer: { ...bankOffer, principal: '30.00' } });
    expect(screen.getByText('Deposit due')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-panel-amount')).toHaveTextContent('$10.00');
    expect(screen.getByText('of $30.00 balance due')).toBeInTheDocument();
    expect(screen.getByText('Pay the deposit once.')).toBeInTheDocument();
    expect(screen.getByText(/Pays the full balance of \$30\.00/)).toBeInTheDocument();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent('Pay deposit $10.00');
    expect(document.body.textContent).not.toMatch(/Balance due\$30/);
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
  it('scheduled with a fee states the total that will be charged, not the balance again (V-28)', () => {
    panel({ balance: '50.00', autopayStatus: scheduled, autopayEnrolled: true });
    expect(screen.queryByText('Amount')).toBeNull();
    expect(screen.getByText('Total charged')).toBeInTheDocument();
    expect(screen.getByText('up to $51.50')).toBeInTheDocument();
  });
  it('scheduled with no fee adds no facts under the balance', () => {
    panel({ balance: '50.00', autopayStatus: { ...scheduled, fee: '0.00' }, autopayEnrolled: true });
    expect(screen.queryByText('Total charged')).toBeNull();
    expect(screen.queryByText('Amount')).toBeNull();
  });
  // V-5, V-29: the processing line names the money actually moving, with its fee.
  it('processing names the in-flight method and total, with the bank timing', () => {
    panel({ balance: '140.00', collectionInProgress: { amount: '140.00', actionRequired: false },
      autopayStatus: { ...scheduled, state: 'processing', chargeDate: null, amount: '140.00', fee: '1.00', canPayNow: false,
        methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' } });
    const line = screen.getByTestId('public-invoice-collection-processing');
    expect(line).toHaveTextContent('$141.00 is being collected from your bank account ending in 6789 ($140.00 for this invoice plus a $1.00 fee).');
    expect(line).toHaveTextContent('Bank payments usually take a few business days to clear.');
    expect(line).not.toHaveTextContent('saved payment method');
  });
  it('an in-flight amount beside a scheduled status never prints the noticed maximum fee as moving', () => {
    panel({ autopayStatus: scheduled, collectionInProgress: { amount: '50.00', actionRequired: false } });
    const line = screen.getByTestId('public-invoice-collection-processing');
    expect(line).toHaveTextContent('$50.00 is being collected from your Visa credit card ending in 4242.');
    expect(line).not.toHaveTextContent('fee');
  });
  it('processing: no action, no Pay', () => {
    panel({ autopayStatus: { ...scheduled, state: 'processing', fee: '0.00', canPayNow: false, methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' }, autopayEnrolled: true });
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
  // V-15: a client whose automatic payments are on (method failing) is not told the bank
  // option "turns on" automatic payments, and the public page says how to fix the method.
  it('with automatic payments on but the method failing, the options say they replace the method', () => {
    panel({ autopayStatus: { ...scheduled, state: 'delayed', reason: 'method_not_usable' }, autopayEnrolled: false, bankOffer, saveOffer });
    expect(screen.getByText('Pays this invoice and uses this bank account for your automatic payments from now on.')).toBeInTheDocument();
    expect(screen.getByText('Pays this invoice now and uses this card for your automatic payments from now on.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/turns on automatic payments/);
    expect(screen.getByText(/To keep automatic payments working, update your payment method with the link in your latest email from Example MSP\./)).toBeInTheDocument();
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

// States the lab could only reach by patching the API: the API's own payload shapes.
describe('realistic payloads (CustomerInvoiceAutopayStatus as the API sends it)', () => {
  const api = (over: Record<string, unknown>) => ({ state: 'scheduled', chargeDate: '2026-11-04', amount: '30.00', fee: '0.90', currency: 'USD',
    methodLabel: 'Visa credit card ending in 4242', methodType: 'card', reason: null, paidAt: null, canPayNow: true, ...over }) as never;
  it.each([
    [{ state: 'awaiting_notice', chargeDate: null, amount: null, fee: null }, "We'll email you the payment date first.", 'Pay now instead'],
    [{ state: 'delayed', reason: 'method_not_usable' }, "We couldn't charge your saved Visa credit card ending in 4242", 'Pay $30.00'],
    [{ state: 'delayed', reason: 'pending_verification', methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' }, 'once your bank account is verified', 'Pay now instead'],
    [{ state: 'delayed', reason: 'on_hold' }, 'is on hold at Example MSP', 'Pay now instead'],
    [{ state: 'retry_scheduled', chargeDate: '2026-11-07' }, "We'll try your Visa credit card ending in 4242 again on November 7, 2026", 'Pay now instead'],
  ] as const)('%j', (over, text, pay) => {
    panel({ balance: '30.00', charge: { amount: '30.00', isDeposit: false }, autopayStatus: api(over) });
    expect(screen.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent(pay);
  });
  it('a deposit invoice the API reports as scheduled', () => {
    panel({ balance: '30.00', charge: { amount: '10.00', isDeposit: true }, autopayStatus: api({}) });
    expect(screen.getByText('Deposit due')).toBeInTheDocument();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent('Pay now instead');
  });
  it('online payment unavailable: no pay button, who to contact', () => {
    panel({ balance: '30.00', canPay: false, onlinePaymentUnavailable: true, autopayStatus: null });
    expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
    expect(screen.getByText("Online payment isn't available for this invoice. Please contact Example MSP to pay.")).toBeInTheDocument();
  });
});

describe('Final-A paper cuts', () => {
  // FP-6
  it('a client bank payment reads "Paid by bank"', () => {
    panel({ status: 'paid', canPay: false, balance: '0.00', autopayStatus: { ...scheduled, state: 'paid_by_bank', paidAt: '2026-10-05T08:00:00Z',
      methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' } as never });
    expect(screen.getByText('Paid by bank on October 5, 2026 from your bank account ending in 6789. Thank you.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/automatically/);
  });
  it('a reversed automatic payment says the invoice is due again', () => {
    panel({ balance: '100.00', autopayStatus: { ...scheduled, state: 'reversed', amount: '100.00' } as never });
    expect(screen.getByText('The automatic payment for this invoice was refunded or returned, so $100.00 is due again. Please pay it below.')).toBeInTheDocument();
    expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent('Pay $200.00');
  });
  // FP-5 (V-15): a failed payment for a client whose automatic payments are on.
  it('a failed payment for an enrolled client never offers to "turn on" automatic payments, and says how to fix the method', () => {
    panel({ autopayStatus: { ...scheduled, state: 'failed', enrollmentActive: true } as never, bankOffer, saveOffer });
    expect(screen.getByText('Pays this invoice and uses this bank account for your automatic payments from now on.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/turns on automatic payments/);
    expect(screen.getByText(/To keep automatic payments working, update your payment method with the link in your latest email from Example MSP\./)).toBeInTheDocument();
  });
  // FP-5 (V-14): the bank module widens the rail at lg instead of growing a very tall column.
  it('choosing the bank marks the rail so the grid can widen it', () => {
    panel({ bankOffer });
    fireEvent.click(screen.getByTestId('autopay-option-bank'));
    expect(screen.getByTestId('invoice-payment-panel')).toHaveAttribute('data-bank-chosen', 'true');
  });
});

describe('FP-4: bank confirmation on the invoice page', () => {
  it('the waiting notice names the fee, and that paying here has none', () => {
    panel({ balance: '90.00', charge: { amount: '90.00', isDeposit: false }, collectionInProgress: { amount: '90.00', actionRequired: true },
      autopayStatus: { ...scheduled, state: 'action_required', amount: '90.00', fee: '2.70', canPayNow: false } as never });
    expect(screen.getByTestId('autopay-confirmation-notice')).toHaveTextContent('The automatic payment of $92.70 ($90.00 plus a $2.70 processing fee)');
    expect(screen.getByTestId('autopay-confirmation-notice')).toHaveTextContent('pay $90.00 now, with no processing fee');
  });
  it('arriving from the emailed confirm link shows the payment was canceled', () => {
    panel({ releasedOnArrival: true, balance: '90.00', charge: { amount: '90.00', isDeposit: false } });
    expect(screen.getByTestId('autopay-confirmation-released')).toHaveTextContent('The automatic payment was canceled.');
  });
});

// F-9
it('captured money not yet applied says it was received, with no Pay', () => {
  panel({ balance: '50.00', charge: { amount: '50.00', isDeposit: false }, bankOffer, saveOffer,
    autopayStatus: { ...scheduled, state: 'unapplied', amount: '81.00', canPayNow: false } as never });
  expect(screen.getByText("We received a payment of $81.00 for this invoice. Example MSP is applying it, so you don't need to pay again.")).toBeInTheDocument();
  expect(screen.queryByTestId('public-invoice-pay')).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(document.body.textContent).not.toMatch(/didn't go through/);
});

// F-8
it('an invoice issued before the updated authorization says so, and offers Pay', () => {
  panel({ autopayStatus: { ...scheduled, state: 'not_included', reason: 'issued_before_authorization' } as never, autopayEnrolled: true });
  expect(screen.getByText("This invoice was issued before your updated authorization, so it isn't paid automatically. Please pay it here.")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/over the limit/);
  expect(screen.getByTestId('public-invoice-pay')).toHaveTextContent('Pay $200.00');
});

// FP-16
it('a scheduled bank payment states its flat fee and total exactly', () => {
  panel({ balance: '50.00', autopayStatus: { ...scheduled, fee: '1.00', methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' } as never, autopayEnrolled: true });
  expect(screen.getByText('$1.00')).toBeInTheDocument();
  expect(screen.getByText('$51.00')).toBeInTheDocument();
  expect(screen.queryByText(/up to/)).toBeNull();
});
