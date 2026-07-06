import { describe, it, expect } from 'vitest';
import { computeChargeNow, depositBadgeState, toCents } from './invoiceDeposit';

describe('toCents', () => {
  it('rounds money strings to integer cents', () => {
    expect(toCents('30.00')).toBe(3000);
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('0.005')).toBe(1); // round-half-up on the ×100 product
  });

  it('treats null/empty/non-finite as 0', () => {
    expect(toCents(null)).toBe(0);
    expect(toCents('')).toBe(0);
    expect(toCents('abc')).toBe(0);
  });
});

describe('computeChargeNow (mirrors @breeze/shared)', () => {
  it('charges the deposit remaining while the deposit is unmet', () => {
    const r = computeChargeNow({ depositDue: '3000.00', amountPaid: '0.00', balance: '10000.00' });
    expect(r).toEqual({ amount: '3000.00', isDeposit: true });
  });

  it('charges the deposit shortfall after a partial deposit payment', () => {
    const r = computeChargeNow({ depositDue: '3000.00', amountPaid: '1000.00', balance: '9000.00' });
    expect(r).toEqual({ amount: '2000.00', isDeposit: true });
  });

  it('charges the full remaining balance once the deposit is satisfied', () => {
    const r = computeChargeNow({ depositDue: '3000.00', amountPaid: '3000.00', balance: '7000.00' });
    expect(r).toEqual({ amount: '7000.00', isDeposit: false });
  });

  it('charges the balance when there is no deposit', () => {
    const r = computeChargeNow({ depositDue: null, amountPaid: '0.00', balance: '100.00' });
    expect(r).toEqual({ amount: '100.00', isDeposit: false });
  });

  it('clamps the deposit charge to the balance (concurrent manual payment)', () => {
    // Deposit 3000 unmet, but only 500 balance remains — never charge past what is owed.
    const r = computeChargeNow({ depositDue: '3000.00', amountPaid: '0.00', balance: '500.00' });
    expect(r).toEqual({ amount: '500.00', isDeposit: true });
  });
});

describe('depositBadgeState', () => {
  it('is null when the invoice has no deposit', () => {
    expect(depositBadgeState({ depositDue: null, amountPaid: '0.00' })).toBeNull();
  });

  it('is unpaid while amountPaid < depositDue', () => {
    expect(depositBadgeState({ depositDue: '3000.00', amountPaid: '2999.99' })).toBe('unpaid');
  });

  it('is paid once amountPaid meets or exceeds depositDue (exact cents, no float drift)', () => {
    expect(depositBadgeState({ depositDue: '3000.00', amountPaid: '3000.00' })).toBe('paid');
    expect(depositBadgeState({ depositDue: '0.10', amountPaid: '0.30' })).toBe('paid');
  });
});
