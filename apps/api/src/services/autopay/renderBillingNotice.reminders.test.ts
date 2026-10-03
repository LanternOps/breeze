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
    expect(rendered.text).toContain(kind === 'payment_overdue' ? 'was due by' : 'is due by');
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
