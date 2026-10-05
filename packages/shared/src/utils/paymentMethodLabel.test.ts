import { describe, expect, it } from 'vitest';
import { cardBrandLabel, formatPaymentMethod } from './paymentMethodLabel';

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
