import { describe, expect, it, vi } from 'vitest';
import type { BillingNoticeKind } from '@breeze/shared';
import type { RenderPartnerEmailArgs } from '../emailTemplates/renderPartnerEmail';
const { renderedArgs } = vi.hoisted(() => ({ renderedArgs: vi.fn() }));
vi.mock('../emailTemplates/renderPartnerEmail', () => ({
  renderPartnerEmail: (args: RenderPartnerEmailArgs) => {
    renderedArgs(args);
    return { subject: 'Frozen subject', html: `${args.custom?.html ?? ''}${args.bodyAfterCta ?? ''}` };
  },
}));
import { renderChargingNotice, renderBillingNotice, registerBillingNoticeRenderer, type BillingNoticeContext } from './renderBillingNotice';

const ctx: BillingNoticeContext = { partnerId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', data: {},
  frozen: { amount: '100.00', date: '2026-10-20' },
  mandatory: { skipUrl: 'https://portal.example.test/skip', stopUrl: 'https://portal.example.test/stop',
    feeDisclosure: 'Fee < $3', achAuthorizationReference: 'Mandate <reference>' } };
describe('billing renderer registry', () => {
  it('starts with no production renderers', async () => {
    await expect(renderBillingNotice('card_expiring', ctx)).rejects.toThrow('No billing renderer');
  });
  it('appends escaped mandatory copy outside a fully replaced editable body', async () => {
    const fakeKind = 'test_only' as BillingNoticeKind;
    registerBillingNoticeRenderer(fakeKind, async () => ({
      email: { id: 'invoice_send', vars: {}, custom: { subject: null, heading: null, buttonLabel: null, html: '<p>Partner replacement</p>' } },
      text: 'Partner text',
    }));
    const result = await renderBillingNotice(fakeKind, ctx);
    expect(result.html).toContain('<p>Partner replacement</p>');
    expect(result.html).toContain('Fee &lt; $3');
    expect(result.html).toContain('Mandate &lt;reference&gt;');
    expect(result.html).toContain('https://portal.example.test/skip');
    expect(result.html).toContain('https://portal.example.test/stop');
    expect(result.text).toContain('Fee < $3');
    expect(result.text).toContain('Stop automatic payments: https://portal.example.test/stop');
    expect(result.frozen).toEqual(ctx.frozen);
    expect(result.frozen).not.toBe(ctx.frozen);
    expect(renderedArgs).toHaveBeenCalledWith(expect.objectContaining({ bodyAfterCta: expect.stringContaining('Stop automatic payments') }));
    await expect(renderBillingNotice(fakeKind, { ...ctx, mandatory: { stopUrl: 'javascript:alert(1)' } })).rejects.toThrow('Unsafe billing URL');
    expect(() => registerBillingNoticeRenderer(fakeKind, async () => ({ email: { id: 'invoice_send', vars: {} }, text: '' }))).toThrow('already registered');
  });
});

it('keeps skip, stop, fee and mandate text outside a partner override', () => {
  const result = renderChargingNotice({
    vars: { org_name: 'Customer', partner_name: 'Provider', invoice_number: 'INV-1',
      amount_due: 'USD 100.00', due_date: '2026-10-01', charge_date: '2026-10-11',
      payment_method: 'Bank ••1234', fee_amount: 'USD 0.00', invoice_link: 'https://portal.example.com/invoice/x' },
    custom: { subject: 'Invoice', heading: 'Invoice', html: '<p>Custom body</p>', buttonLabel: null },
    skipUrl: 'https://portal.example.com/autopay/s/skip',
    stopUrl: 'https://portal.example.com/autopay/t/stop',
    feeText: 'Processing fee: USD 0.00', authorizationText: 'Authorized bank debit; initiation date shown above.',
    frozen: { amount: '100.00', fee: '0.00', chargeDate: '2026-10-11' },
  });
  expect(result.html).toContain('/autopay/s/skip');
  expect(result.html).toContain('/autopay/t/stop');
  expect(result.html).toContain('Processing fee: USD 0.00');
  expect(result.html).toContain('Authorized bank debit');
  expect(result.text).toContain('/autopay/s/skip');
  expect(result.frozen.amount).toBe('100.00');
});

const chargingContext = {
  vars: { invoice_number: 'INV-1', amount_due: 'USD 100.00', charge_date: '2026-10-11',
    payment_method: 'Bank ••1234', invoice_link: 'https://portal.example.com/invoice/x' },
  skipUrl: 'https://portal.example.com/autopay/s/skip',
  stopUrl: 'https://portal.example.com/autopay/t/stop',
  feeText: 'Fee < USD 3.00', authorizationText: 'Mandate <reference>',
  frozen: { amount: '100.00', fee: '0.00', chargeDate: '2026-10-11' },
};

it('dispatches charging context and rejects a mismatched notice kind', async () => {
  const result = await renderBillingNotice('invoice_autopay', { charging: chargingContext });
  expect(result.html).toContain('Fee &lt; USD 3.00');
  expect(result.html).toContain('Mandate &lt;reference&gt;');
  expect(result.text).toContain('Invoice: https://portal.example.com/invoice/x');
  expect(result.text).toContain('Stop: https://portal.example.com/autopay/t/stop');
  expect(result.frozen).toEqual(chargingContext.frozen);
  await expect(renderBillingNotice('autopay_request', { charging: chargingContext }))
    .rejects.toThrow('Wrong charging notice context');
});

it.each(['javascript:alert(1)', 'https://user:password@portal.example.com', 'invalid'])(
  'rejects unsafe URLs in each charging link: %s', url => {
    expect(() => renderChargingNotice({ ...chargingContext, skipUrl: url })).toThrow();
    expect(() => renderChargingNotice({ ...chargingContext, stopUrl: url })).toThrow();
    expect(() => renderChargingNotice({ ...chargingContext,
      vars: { ...chargingContext.vars, invoice_link: url } })).toThrow();
  },
);

it('preserves receipt fee disclosure despite a hostile template replacement', async () => {
  const payment = { id: 'payment_receipt' as const, vars: { fee_amount: 'USD <3.00>', amount_paid: 'USD 100.00' },
    custom: { html: '<p>No fee mentioned</p>', subject: null, heading: null, buttonLabel: null }, frozen: { amount: '100.00', fee: '3.00' } };
  const result = await renderBillingNotice('payment_receipt', { payment });
  expect(result.html).toContain('Processing fee: USD &lt;3.00&gt;');
  expect(result.text).toContain('Processing fee: USD <3.00>');
  expect(result.text).toContain('No fee mentioned');
  expect(result.text).not.toContain('fee_amount:');
  expect(result.frozen).toEqual(payment.frozen);
  await expect(renderBillingNotice('payment_failed', { payment })).rejects.toThrow('Missing payment notice context');
});
it('uses the failure action URL and label', async () => {
  await renderBillingNotice('payment_failed', { payment: { id: 'payment_failed',
    vars: { action_link: 'https://example.test/confirm', action_label: 'Confirm payment' }, custom: null, frozen: {} } });
  expect(renderedArgs).toHaveBeenLastCalledWith(expect.objectContaining({ ctaUrl: 'https://example.test/confirm', ctaLabel: 'Confirm payment' }));
});

it('keeps receipt itemization when the partner removes every editable amount', async () => {
  const out = await renderBillingNotice('payment_receipt', { payment: {
    id: 'payment_receipt', custom: { subject:'Thank you', heading:'Paid', html:'<p>Thank you</p>', buttonLabel:'' },
    vars: { partner_name:'Example MSP', org_name:'Example customer', invoice_number:'INV-1', amount_paid:'USD 100.00',
      fee_amount:'USD 3.00', total_charged:'USD 103.00', payment_method:'Visa ••4242', paid_on:'2026-10-01', balance_remaining:'USD 0.00' },
    frozen: { amount:'100.00', fee:'3.00', total:'103.00' },
  } });
  for (const value of ['Principal: USD 100.00','Processing fee: USD 3.00','Total charged: USD 103.00']) {
    expect(out.html).toContain(value); expect(out.text).toContain(value);
  }
  expect(out.frozen).toEqual({ amount:'100.00', fee:'3.00', total:'103.00' });
});

it('keeps principal plus card fee outside edited invoice notice text',async()=>{
  const feeText='$100.00 + $3.00 card processing fee';
  const out=await renderBillingNotice('invoice_autopay',{charging:{
    vars:{org_name:'Customer',partner_name:'Provider',invoice_number:'INV-1',amount_due:'USD 100.00',
      due_date:'2026-10-01',charge_date:'2026-10-11',payment_method:'Visa ••4242',fee_amount:'USD 3.00',
      invoice_link:'https://portal.example.test/invoice/token'},
    custom:{subject:'Invoice',heading:'Invoice',html:'<p>Edited without amounts</p>',buttonLabel:null},
    skipUrl:'https://portal.example.test/autopay/skip/skip',stopUrl:'https://portal.example.test/autopay/stop/stop',
    feeText,authorizationText:'Payment authorized during automatic payment setup.',
    frozen:{amount:'100.00',fee:'3.00',chargeDate:'2026-10-11'},
  }});
  expect(out.html).toContain(feeText);expect(out.text).toContain(feeText);
  expect(out.frozen).toEqual({amount:'100.00',fee:'3.00',chargeDate:'2026-10-11'});
});
