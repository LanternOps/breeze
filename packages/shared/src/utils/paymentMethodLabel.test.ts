import { describe, expect, it } from 'vitest';
import {
  autopayScheduleSummary, formatCalendarDate, formatMonthYear, formatPaymentMethod, formatPercentBps,
} from './paymentMethodLabel';

describe('formatPaymentMethod', () => {
  it.each([
    [{ type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242' }, 'Visa credit card ending in 4242', 'Visa ending in 4242'],
    [{ type: 'card', cardBrand: 'mastercard', cardFunding: 'debit', cardLast4: '8210' }, 'Mastercard debit card ending in 8210', 'Mastercard ending in 8210'],
    [{ type: 'card', cardBrand: 'amex', cardFunding: 'unknown', cardLast4: '0005' }, 'American Express card ending in 0005', 'American Express ending in 0005'],
    [{ type: 'card', cardBrand: 'cartes_bancaires', cardFunding: 'prepaid', cardLast4: '1111' }, 'Cartes Bancaires prepaid card ending in 1111', 'Cartes Bancaires ending in 1111'],
    [{ type: 'card', cardBrand: null, cardFunding: 'credit', cardLast4: '4242' }, 'Credit card ending in 4242', 'Card ending in 4242'],
    [{ type: 'card', cardBrand: 'some_new_network', cardFunding: null, cardLast4: null }, 'Card', 'Card'],
    [{ type: 'card', cardBrand: 'link', cardFunding: 'unknown', cardLast4: '0000' }, 'Link ending in 0000', 'Link ending in 0000'],
    [{ type: 'us_bank_account', bankName: 'STRIPE TEST BANK', bankLast4: '6789' }, 'Bank account ending in 6789', 'Bank account ending in 6789'],
    [{ type: 'us_bank_account', bankName: null, bankLast4: null }, 'Bank account', 'Bank account'],
  ])('%j reads as human words', (method, long, short) => {
    expect(formatPaymentMethod(method)).toBe(long);
    expect(formatPaymentMethod(method, 'short')).toBe(short);
  });

  it('never prints a raw brand slug or funding code', () => {
    const label = formatPaymentMethod({ type: 'card', cardBrand: 'diners', cardFunding: 'unknown', cardLast4: '9999' });
    expect(label).toBe('Diners Club card ending in 9999');
    expect(label).not.toMatch(/unknown|diners /);
  });
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
