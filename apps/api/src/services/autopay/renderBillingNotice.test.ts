import { describe, expect, it } from 'vitest';
import type { BillingNoticeKind } from '@breeze/shared';
import { renderChargingNotice, renderBillingNotice, registerBillingNoticeRenderer, renderRefundNotice, type BillingNoticeContext } from './renderBillingNotice';

const ctx: BillingNoticeContext = { partnerId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', data: {},
  frozen: { amount: '100.00', date: '2026-10-20' },
  mandatory: { skipUrl: 'https://portal.example.test/skip', stopUrl: 'https://portal.example.test/stop',
    feeDisclosure: 'Fee < $3', achAuthorizationReference: 'Mandate <reference>' } };
const once = (text: string, needle: string) => text.split(needle).length - 1;

describe('billing renderer registry', () => {
  it('starts with no production renderers for unregistered kinds', async () => {
    await expect(renderBillingNotice('card_expiring', ctx)).rejects.toThrow('No billing renderer');
  });
  it('appends escaped mandatory copy outside a fully replaced editable body', async () => {
    const fakeKind = 'test_only' as BillingNoticeKind;
    registerBillingNoticeRenderer(fakeKind, async () => ({ id: 'invoice_send', vars: {}, brandName: 'Example MSP',
      custom: { subject: 'S', heading: 'H', buttonLabel: null, html: '<p>Partner replacement</p>' } }));
    const result = await renderBillingNotice(fakeKind, ctx);
    expect(result.html).toContain('<p>Partner replacement</p>');
    expect(result.html).toContain('Fee &lt; $3');
    expect(result.html).toContain('Mandate &lt;reference&gt;');
    expect(result.html).toContain('href="https://portal.example.test/skip"');
    expect(result.html).toContain('href="https://portal.example.test/stop"');
    expect(result.text).toContain('Fee < $3');
    expect(result.text).toContain('Stop automatic payments: https://portal.example.test/stop');
    expect(result.frozen).toEqual(ctx.frozen);
    expect(result.frozen).not.toBe(ctx.frozen);
    await expect(renderBillingNotice(fakeKind, { ...ctx, mandatory: { stopUrl: 'javascript:alert(1)' } })).rejects.toThrow('Unsafe billing URL');
    expect(() => registerBillingNoticeRenderer(fakeKind, async () => ({ id: 'invoice_send', vars: {}, brandName: '' }))).toThrow('already registered');
  });
});

const chargingContext = {
  vars: { partner_name: 'Example MSP', client_name: 'Acme', invoice_number: 'INV-1', amount_due: '$100.00', fee_amount: '$3.00', charge_total: '$103.00',
    charge_date: 'October 11, 2026', due_date: 'October 1, 2026', payment_method: 'Visa credit card ending in 4242',
    invoice_link: 'https://portal.example.com/invoice/x' },
  methodLabel: 'Visa credit card ending in 4242',
  skipUrl: 'https://portal.example.com/autopay/s/skip',
  stopUrl: 'https://portal.example.com/autopay/t/stop',
  authorizationText: 'You authorized this payment when you set up automatic payments with Example MSP.',
  frozen: { amount: '100.00', fee: '3.00', chargeDate: '2026-10-11' },
};

describe('the pre-charge notice', () => {
  it('locks the amount, fee, total, date, method, skip, stop and authorization outside a partner override', () => {
    const result = renderChargingNotice({ ...chargingContext,
      custom: { subject: 'Invoice', heading: 'Invoice', html: '<p>Edited without amounts</p>', buttonLabel: null } });
    for (const value of ['Amount: $100.00', 'Processing fee: up to $3.00', 'Total charge: up to $103.00', 'Payment date: On or around October 11, 2026',
      'Payment method: Visa credit card ending in 4242', 'Due date: October 1, 2026',
      'Skip this payment: https://portal.example.com/autopay/s/skip', 'Stop automatic payments: https://portal.example.com/autopay/t/stop',
      'You authorized this payment when you set up automatic payments with Example MSP.']) {
      expect(once(result.text, value), value).toBe(1);
    }
    expect(result.html).toContain('Edited without amounts');
    expect(result.html).toContain('>Total charge</td>');
    expect(result.text).not.toMatch(/USD \d/);
    expect(result.frozen.amount).toBe('100.00');
  });
  it('a fee-free notice prints no fee or total row', () => {
    const result = renderChargingNotice({ ...chargingContext, frozen: { ...chargingContext.frozen, fee: '0.00' } });
    expect(result.text).not.toContain('Processing fee');
    expect(result.text).not.toContain('Total charge');
  });
  it('dispatches the charging context and rejects a mismatched notice kind', async () => {
    const result = await renderBillingNotice('invoice_autopay', { charging: chargingContext });
    expect(result.text).toContain('View invoice: https://portal.example.com/invoice/x');
    expect(result.subject).toBe('Invoice INV-1 from Example MSP: automatic payment on October 11, 2026');
    await expect(renderBillingNotice('autopay_request', { charging: chargingContext })).rejects.toThrow('Wrong charging notice context');
  });
  it.each(['javascript:alert(1)', 'https://user:password@portal.example.com', 'invalid'])('rejects unsafe URLs in each link: %s', url => {
    expect(() => renderChargingNotice({ ...chargingContext, skipUrl: url })).toThrow();
    expect(() => renderChargingNotice({ ...chargingContext, stopUrl: url })).toThrow();
    expect(() => renderChargingNotice({ ...chargingContext, vars: { ...chargingContext.vars, invoice_link: url } })).toThrow();
  });
});

describe('payment notices', () => {
  const receipt = { id: 'payment_receipt' as const, custom: null, frozen: { amount: '100.00', fee: '3.00', total: '103.00' },
    vars: { partner_name: 'Example MSP', client_name: 'Acme', invoice_number: 'INV-1', amount_paid: '$100.00', fee_amount: '$3.00',
      total_charged: '$103.00', payment_method: 'Visa credit card ending in 4242', paid_on: 'October 1, 2026', balance_remaining: 'Paid in full' } };
  it('a receipt itemizes the payment once, even when the partner removes every amount', async () => {
    const out = await renderBillingNotice('payment_receipt', { payment: { ...receipt,
      custom: { subject: 'Thank you', heading: 'Paid', html: '<p>Thank you</p>', buttonLabel: '' } } });
    for (const value of ['Invoice: INV-1', 'Amount paid: $100.00', 'Processing fee: $3.00', 'Total charged: $103.00',
      'Paid with: Visa credit card ending in 4242', 'Paid on: October 1, 2026', 'Balance: Paid in full']) {
      expect(once(out.text, value), value).toBe(1);
    }
    expect(out.html).toContain('>Paid with</td>');
    expect(out.html).toContain('>Example MSP</p>');
    expect(out.frozen).toEqual(receipt.frozen);
  });
  it('a fee-free receipt prints no fee or total row; "online payment" is capitalized in the table', async () => {
    const out = await renderBillingNotice('payment_receipt', { payment: { ...receipt, frozen: { ...receipt.frozen, fee: '0.00' },
      vars: { ...receipt.vars, payment_method: 'online payment' } } });
    expect(out.text).not.toContain('Processing fee');
    expect(out.text).toContain('Paid with: Online payment');
  });
  it('rejects a mismatched payment context', async () => {
    await expect(renderBillingNotice('payment_failed', { payment: receipt })).rejects.toThrow('Missing payment notice context');
  });
  it('a failure leads with its action and keeps a second action with its note outside the editable body', async () => {
    const out = await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed', variant: 'update',
      vars: { partner_name: 'Example MSP', client_name: 'Acme', invoice_number: 'INV-1', amount_due: '$100.00',
        payment_method: 'Visa credit card ending in 4242', failure_text: 'Declined.', action_link: 'https://example.test/pay', action_label: 'Pay invoice' },
      custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Partner body without links</p>' }, frozen: {},
      secondaryAction: { url: 'https://example.test/update', label: 'Update payment method',
        note: 'Updating keeps future invoices working. It does not pay this invoice.' } } });
    expect(out.subject).toBe('Action needed for invoice INV-1: update your payment method');
    expect(out.html).toContain('href="https://example.test/update"');
    expect(once(out.text, 'Pay invoice: https://example.test/pay')).toBe(1);
    expect(out.text).toContain('It does not pay this invoice. Update payment method: https://example.test/update');
    expect(out.text).toContain('Amount due: $100.00');
    await expect(renderBillingNotice('payment_failed', { payment: { id: 'payment_failed',
      vars: { action_link: 'https://example.test/pay', action_label: 'Pay invoice' }, custom: null, frozen: {},
      secondaryAction: { url: 'javascript:alert(1)', label: 'Update payment method', note: '' } } })).rejects.toThrow('Unsafe billing URL');
  });
  it('the confirm variant names the payment to confirm and the amount due on the invoice', async () => {
    const out = await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed', variant: 'confirm', custom: null, frozen: {},
      vars: { partner_name: 'Example MSP', client_name: 'Acme', invoice_number: 'INV-1', amount_due: '$100.00', attempted_amount: '$103.00',
        failure_text: 'Your bank asked you to confirm it.', action_link: 'https://example.test/confirm', action_label: 'Confirm payment',
        payment_method: 'Visa credit card ending in 3184' } } });
    expect(out.subject).toBe('Confirm your payment for invoice INV-1');
    expect(out.text).toContain('Payment to confirm: $103.00');
    expect(out.text).toContain('Amount due on the invoice: $100.00');
    expect(out.text).toContain('Confirm payment: https://example.test/confirm');
  });
});

it('a refund keeps its locked wording and states the facts once', () => {
  const out = renderRefundNotice({ partnerName: 'Example MSP', clientName: 'Acme', invoiceNumber: 'INV-1', refunded: '$40.00',
    refundedTo: 'Visa credit card ending in 4242', originalPayment: '$103.00 on October 1, 2026', full: false,
    balanceLine: 'Balance due on invoice INV-1 after this refund: $40.00', invoiceUrl: 'https://portal.example.test/i', frozen: {} });
  expect(out.subject).toBe('Refund for invoice INV-1 from Example MSP');
  for (const value of ['Refunded: $40.00', 'Refunded to: Visa credit card ending in 4242', 'Original payment: $103.00 on October 1, 2026',
    'Balance due on invoice INV-1 after this refund: $40.00', 'View invoice: https://portal.example.test/i']) {
    expect(once(out.text, value), value).toBe(1);
  }
  expect(out.text).toContain('Example MSP has refunded part of your payment for invoice INV-1.');
});
