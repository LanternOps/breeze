import { describe, expect, it } from 'vitest';
import { cardBrandLabel, methodLabel } from './autopayClient';
import type { AutopayRow } from './autopayClient';
const card = (brand: string | null, month: number | null = 12, year: number | null = 2031): NonNullable<AutopayRow['method']> => ({
  type: 'card', cardBrand: brand, cardFunding: 'credit', cardLast4: '4242', cardExpMonth: month, cardExpYear: year,
  bankName: null, bankLast4: null, status: 'active' });
describe('card brand labels on staff screens', () => {
  it.each([
    ['visa', 'Visa'], ['VISA', 'Visa'], ['mastercard', 'Mastercard'], ['amex', 'American Express'],
    ['discover', 'Discover'], ['diners', 'Diners Club'], ['jcb', 'JCB'], ['unionpay', 'UnionPay'],
    ['cartes_bancaires', 'Cartes Bancaires'], ['eftpos_au', 'eftpos Australia'], ['interac', 'Interac'], ['link', 'Link'],
  ])('shows Stripe brand %s as %s', (brand, label) => expect(cardBrandLabel(brand)).toBe(label));
  it.each([null, '', 'unknown'])('shows a generic card for brand %j', brand => expect(cardBrandLabel(brand)).toBe('Card'));
  it('title-cases a brand Stripe adds later instead of printing its code', () => {
    expect(cardBrandLabel('new_network')).toBe('New Network');
  });
  it('formats the method with the brand name and a two-digit expiry month', () => {
    expect(methodLabel(card('visa'))).toBe('Visa ••4242 12/2031');
    expect(methodLabel(card('amex', 3, 2027))).toBe('American Express ••4242 03/2027');
    expect(methodLabel(card('mastercard', null, null))).toBe('Mastercard ••4242');
  });
});
