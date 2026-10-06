import { describe, expect, it } from 'vitest';
import { clientNameFor, emailDate, emailMoney, renderBillingEmail } from './billingEmail';

const base = {
  id: 'invoice_autopay' as const, brandName: 'Example MSP', ctaUrl: 'https://portal.example.test/invoice/tok',
  vars: { partner_name: 'Example MSP', client_name: 'Acme Dental', invoice_number: 'INV-7', charge_date: 'November 4, 2026',
    payment_method: 'Visa credit card ending in 4242' },
  summary: [{ label: 'Amount', value: '$50.00' }, { label: 'Payment date', value: 'On or around November 4, 2026' }],
  links: [{ label: 'Skip this payment', url: 'https://portal.example.test/skip' }, { label: 'Stop automatic payments', url: 'https://portal.example.test/stop' }],
  terms: { title: 'Your authorization', paragraphs: ['You authorized this payment when you set up automatic payments.'] },
};

describe('renderBillingEmail', () => {
  it('composes the partner body, then the locked facts, links and terms in the HTML', () => {
    const { html } = renderBillingEmail(base);
    const body = html.indexOf('it will be paid automatically');
    const summary = html.indexOf('>Payment date</td>');
    const links = html.indexOf('>Skip this payment</a>');
    const terms = html.indexOf('Your authorization');
    expect(body).toBeGreaterThan(0);
    expect(summary).toBeGreaterThan(body);
    expect(links).toBeGreaterThan(summary);
    expect(terms).toBeGreaterThan(links);
    expect(html).toContain('>Example MSP</p>');
  });

  it('the text part says each fact once, in the same order, with no preheader or hidden text', () => {
    const { text, html } = renderBillingEmail(base);
    expect(text.startsWith('Invoice INV-7\n\nHi Acme Dental,')).toBe(true);
    for (const line of ['Amount: $50.00', 'Payment date: On or around November 4, 2026', 'View invoice: https://portal.example.test/invoice/tok',
      'Skip this payment: https://portal.example.test/skip', 'Stop automatic payments: https://portal.example.test/stop',
      'You authorized this payment when you set up automatic payments.']) {
      expect(text.split(line).length - 1, line).toBe(1);
    }
    expect(text).not.toContain('Your invoice and the date it will be paid automatically.');
    expect(text.trim().endsWith('Example MSP')).toBe(true);
    expect(text.indexOf('Amount: $50.00')).toBeLessThan(text.indexOf('Skip this payment:'));
    expect(html).not.toMatch(/<p>\s*<!doctype/i);
  });

  it('lists open invoices with their pay links once', () => {
    const { html, text } = renderBillingEmail({ ...base, id: 'autopay_stopped', ctaUrl: undefined, summary: undefined, links: undefined, terms: undefined,
      openInvoices: [{ number: 'INV-4', amount: '$100.00', url: 'https://portal.example.test/i/4' }] });
    expect(html).toContain('Invoices still open');
    expect(html).toContain('href="https://portal.example.test/i/4"');
    expect(text).toContain('INV-4 · $100.00: https://portal.example.test/i/4');
  });

  it('says so when no invoices are open', () => {
    const { text } = renderBillingEmail({ ...base, id: 'autopay_stopped', ctaUrl: undefined, summary: undefined, links: undefined, terms: undefined, openInvoices: [] });
    expect(text).toContain('You have no open invoices right now.');
    expect(text).not.toContain('Invoices still open');
  });

  it('a link with a note keeps the note beside it', () => {
    const { html, text } = renderBillingEmail({ ...base, links: [{ label: 'Update payment method', url: 'https://x.test/u', note: 'It does not pay this invoice.' }] });
    expect(html).toContain('It does not pay this invoice. <a href="https://x.test/u"');
    expect(text).toContain('It does not pay this invoice. Update payment method: https://x.test/u');
  });

  it('refuses an unsafe link', () => {
    expect(() => renderBillingEmail({ ...base, links: [{ label: 'x', url: 'javascript:alert(1)' }] })).toThrow();
  });
});

describe('billing email words', () => {
  it('one money formatter', () => {
    expect(emailMoney('100.00', 'USD')).toBe('$100.00');
    expect(emailMoney('1234.5', 'CAD')).toBe('CA$1,234.50');
  });
  it('one date formatter, calendar-true', () => {
    expect(emailDate('2026-11-04')).toBe('November 4, 2026');
    expect(emailDate(new Date('2026-10-05T23:30:00Z'))).toBe('October 5, 2026');
    expect(emailDate(null)).toBe('');
  });
  it('greets a person or the organization, never an email address', () => {
    expect(clientNameFor({ name: ' Pat Lee ', email: 'pat@example.test' }, 'Acme')).toBe('Pat Lee');
    expect(clientNameFor({ email: 'pat@example.test' }, 'Acme')).toBe('Acme');
    expect(clientNameFor({ name: 'pat@example.test' }, 'Acme')).toBe('Acme');
    expect(clientNameFor(null, '')).toBe('there');
  });
});
