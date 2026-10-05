import { describe, expect, it } from 'vitest';
import {
  autopayScheduleSummary, cardBrandLabel, formatCalendarDate, formatMonthYear, formatPaymentMethod, formatPercentBps, paymentMethodInSentence,
} from './paymentMethodLabel';

describe('cardBrandLabel', () => {
  it.each([
    ['visa', 'Visa'], ['mastercard', 'Mastercard'], ['amex', 'American Express'], ['discover', 'Discover'],
    ['diners', 'Diners Club'], ['jcb', 'JCB'], ['unionpay', 'UnionPay'], ['cartes_bancaires', 'Cartes Bancaires'],
    ['eftpos_au', 'eftpos Australia'], ['interac', 'Interac'], ['link', 'Link'], ['VISA', 'Visa'], [' visa ', 'Visa'],
  ])('names Stripe brand code %s as %s', (code, label) => {
    expect(cardBrandLabel(code)).toBe(label);
  });
  it.each([null, undefined, '', 'unknown'])('falls back to "Card" for %s', code => {
    expect(cardBrandLabel(code)).toBe('Card');
  });
  it('reads a brand Stripe adds later as words, never as its code', () => {
    expect(cardBrandLabel('new_network')).toBe('New Network');
  });
});

describe('formatPaymentMethod', () => {
  const card = { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242' };
  it('labels a card with brand, funding and last four (long) or brand and last four (short)', () => {
    expect(formatPaymentMethod(card)).toBe('Visa credit card ending in 4242');
    expect(formatPaymentMethod(card, 'short')).toBe('Visa ending in 4242');
    expect(formatPaymentMethod({ ...card, cardBrand: 'mastercard', cardFunding: 'debit', cardLast4: '8210' }))
      .toBe('Mastercard debit card ending in 8210');
  });
  it.each([['unknown'], [null], [undefined]])('omits funding %s', funding => {
    expect(formatPaymentMethod({ ...card, cardFunding: funding })).toBe('Visa card ending in 4242');
  });
  it('never prints a raw Stripe code for a card without a known brand', () => {
    expect(formatPaymentMethod({ ...card, cardBrand: null })).toBe('Credit card ending in 4242');
    expect(formatPaymentMethod({ ...card, cardBrand: 'unknown', cardFunding: null })).toBe('Card ending in 4242');
    expect(formatPaymentMethod({ ...card, cardBrand: null }, 'short')).toBe('Card ending in 4242');
  });
  it('names a Link wallet without calling it a card', () => {
    expect(formatPaymentMethod({ ...card, cardBrand: 'link', cardFunding: 'unknown', cardLast4: '0000' })).toBe('Link ending in 0000');
    expect(formatPaymentMethod({ ...card, cardBrand: 'link', cardLast4: '0000' }, 'short')).toBe('Link ending in 0000');
  });
  it('labels a bank account by its last four, never by a bank code', () => {
    const bank = { type: 'us_bank_account', bankName: 'STRIPE TEST BANK', bankLast4: '6789' };
    expect(formatPaymentMethod(bank)).toBe('Bank account ending in 6789');
    expect(formatPaymentMethod(bank, 'short')).toBe('Bank account ending in 6789');
  });
  it('drops "ending in" when the last four are unknown', () => {
    expect(formatPaymentMethod({ ...card, cardLast4: null })).toBe('Visa credit card');
    expect(formatPaymentMethod({ type: 'us_bank_account', bankLast4: '' })).toBe('Bank account');
  });
  it('falls back to a generic label for an unknown method type', () => {
    expect(formatPaymentMethod({ type: 'klarna' })).toBe('Payment method');
  });
});

describe('paymentMethodInSentence', () => {
  it.each([
    ['Bank account ending in 6789', 'bank account ending in 6789'], ['Card ending in 4242', 'card ending in 4242'],
    ['Credit card ending in 4242', 'credit card ending in 4242'], ['Online payment', 'online payment'],
    ['Visa credit card ending in 4242', 'Visa credit card ending in 4242'], ['Link ending in 0000', 'Link ending in 0000'],
  ])('%s reads as %s mid-sentence', (label, expected) => expect(paymentMethodInSentence(label)).toBe(expected));
});

describe('formatPercentBps', () => {
  it.each([[300, '3%'], [250, '2.5%'], [299, '2.99%'], [0, '0%'], [10, '0.1%']])('%i bps → %s', (bps, text) => {
    expect(formatPercentBps(bps)).toBe(text);
  });
});

describe('formatCalendarDate', () => {
  it('renders a date-only value as that calendar day in any timezone', () => {
    expect(formatCalendarDate('2026-11-04')).toBe('November 4, 2026');
    expect(formatCalendarDate('2026-01-01', 'en-US')).toBe('January 1, 2026');
  });
  it('renders a timestamp in the requested zone and leaves bad input untouched', () => {
    expect(formatCalendarDate('2026-10-05T04:05:08.366Z', 'en-US', 'UTC')).toBe('October 5, 2026');
    expect(formatCalendarDate('not a date')).toBe('not a date');
    expect(formatCalendarDate(null)).toBe('');
  });
});

describe('formatMonthYear', () => {
  it('names the month', () => {
    expect(formatMonthYear(12, 2031)).toBe('December 2031');
    expect(formatMonthYear(null, 2031)).toBe('');
  });
});

describe('autopayScheduleSummary', () => {
  it.each([
    [{ offsetDays: 0, rule: 'later' }, "On each invoice's due date"],
    [{ offsetDays: 0, rule: 'earlier' }, 'On the day each invoice is issued'],
    [{ offsetDays: 1, rule: 'later' }, "On the due date, or 1 day after the invoice is issued if that's later"],
    [{ offsetDays: 14, rule: 'later' }, "On the due date, or 14 days after the invoice is issued if that's later"],
    [{ offsetDays: 7, rule: 'earlier' }, "7 days after the invoice is issued, or on the due date if that's sooner"],
  ] as const)('%j', (terms, text) => {
    expect(autopayScheduleSummary(terms)).toBe(text);
  });
});
