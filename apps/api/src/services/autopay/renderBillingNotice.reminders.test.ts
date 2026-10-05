import { describe, expect, it } from 'vitest';
import { renderBillingNotice } from './renderBillingNotice';

const ctx = {
  partnerId: '11111111-1111-4111-8111-111111111111', orgId: '22222222-2222-4222-8222-222222222222',
  frozen: { amount: '25.05', currency: 'EUR', dueDate: '2026-10-08', daysOverdue: 7 }, mandatory: {},
  data: {
    invoiceNumber: 'INV-1', balance: '25.05', currency: 'EUR', dueDate: '2026-10-08',
    daysOverdue: 7, payLink: 'https://portal.example.test/invoice/opaque-token',
    partnerName: 'Example MSP', orgName: 'Example Org', partnerSettings: {},
  },
};

describe('reminder rendering', () => {
  it.each(['payment_reminder', 'payment_overdue'] as const)('renders %s with balance and invoice currency', async (kind) => {
    const rendered = await renderBillingNotice(kind, ctx);
    expect(rendered.html).toContain('25.05');
    expect(rendered.html).toContain('€');
    expect(rendered.html).not.toContain('100.00');
    expect(rendered.html).toContain(ctx.data.payLink);
    expect(rendered.text).toContain(ctx.data.payLink);
    expect(rendered.text).toContain(kind === 'payment_overdue' ? 'was due on October 8, 2026 and is now overdue' : 'is due on October 8, 2026');
    expect(rendered.text).toContain('Hi Example Org,');
    expect(rendered.text.split(ctx.data.payLink).length - 1).toBe(1);
    expect(rendered.subject).not.toMatch(/OVERDUE/);
    expect(rendered.frozen).toEqual({
      amount: '25.05', currency: 'EUR', dueDate: '2026-10-08', daysOverdue: 7,
    });
  });
  it('renders partner overrides safely and preserves the CTA if the body omits it', async () => {
    const rendered = await renderBillingNotice('payment_reminder', {
      ...ctx, data: { ...ctx.data, invoiceNumber: '<img src=x onerror=bad()>',
        partnerSettings: { emailTemplates: { payment_reminder: {
          subject: '{{invoice_number}}\r\nReminder', heading: 'Invoice', buttonLabel: 'Pay',
          html: '<p>Custom {{amount_due}} {{invoice_number}}</p>',
        } } },
      },
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html).toContain('&lt;img');
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).toContain(ctx.data.payLink);
    expect(rendered.text).toContain('Custom');
  });
  it('refuses a non-HTTP pay link instead of freezing an unsafe email', async () => {
    await expect(renderBillingNotice('payment_overdue', {
      ...ctx, data: { ...ctx.data, payLink: 'javascript:alert(1)' },
    })).rejects.toThrow('Invalid reminder pay URL');
  });
});

it.each([
  ['skipped', 'Automatic payment skipped for invoice INV-1', 'You skipped the automatic payment for invoice INV-1'],
  ['excluded', 'Automatic payment cancelled for invoice INV-1', 'Example MSP will not charge invoice INV-1 automatically'],
] as const)('the %s confirmation has locked wording a partner reminder override cannot replace', async (variant, subject, line) => {
  const rendered = await renderBillingNotice('payment_reminder', { ...ctx, data: { ...ctx.data, variant, announcedFor: '2026-11-04', clientName: 'Pat Lee',
    partnerSettings: { emailTemplates: { payment_reminder: { subject: 'Friendly reminder', heading: null, buttonLabel: null, html: '<p>Please pay soon.</p>' } } } } });
  expect(rendered.subject).toBe(subject);
  expect(rendered.text).toContain(line);
  expect(rendered.text).toContain('Hi Pat Lee,');
  expect(rendered.text).not.toContain('Please pay soon.');
  expect(rendered.html).not.toMatch(/<p>[^<]*<!doctype/i);
  if (variant === 'excluded') expect(rendered.text).toContain('The automatic payment announced for on or around November 4, 2026 will not happen.');
});

it.each(['payment_receipt','payment_failed'] as const)('renders readable %s text from the actual template',async kind=>{
 const rendered=await renderBillingNotice(kind,{payment:{id:kind,custom:null,frozen:{},vars:{
 org_name:'Example Org',partner_name:'Example MSP',invoice_number:'INV-1',amount_due:'USD 100.00',
 amount_paid:'USD 100.00',fee_amount:'USD 3.00',total_charged:'USD 103.00',payment_method:'Visa ••4242',
 paid_on:'2026-10-03',balance_remaining:'USD 0.00',failure_text:'Your bank requires confirmation.',
 action_link:'https://portal.example.test/confirm',action_label:'Confirm payment'}}});
 expect(rendered.subject).toContain('INV-1');expect(rendered.text).not.toMatch(/org_name:|amount_paid:|failure_text:/);
 if(kind==='payment_failed') {expect(rendered.text).toContain('Your bank requires confirmation.');expect(rendered.text).toContain('https://portal.example.test/confirm');}
 else {expect(rendered.text).toContain('Visa ••4242');expect(rendered.text).toContain('Processing fee: USD 3.00');}
});
