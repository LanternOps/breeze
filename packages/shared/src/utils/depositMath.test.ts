// packages/shared/src/utils/depositMath.test.ts
import { describe, it, expect } from 'vitest';
import { computeChargeNow, computeCheckoutCharge } from './depositMath';
import { fromMinorUnits } from './currency';

describe('computeChargeNow', () => {
  it('no deposit → full balance', () => {
    expect(computeChargeNow({ depositDue: null, amountPaid: '0.00', balance: '10000.00' }))
      .toEqual({ amount: '10000.00', isDeposit: false });
  });
  it('deposit unpaid → deposit amount', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '0.00', balance: '10000.00' }))
      .toEqual({ amount: '3000.00', isDeposit: true });
  });
  it('deposit partly paid (manual check) → deposit remainder', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '1000.00', balance: '9000.00' }))
      .toEqual({ amount: '2000.00', isDeposit: true });
  });
  it('deposit satisfied → remaining balance', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '3000.00', balance: '7000.00' }))
      .toEqual({ amount: '7000.00', isDeposit: false });
  });
  it('overpaid past deposit → remaining balance', () => {
    expect(computeChargeNow({ depositDue: '3000.00', amountPaid: '5000.00', balance: '5000.00' }))
      .toEqual({ amount: '5000.00', isDeposit: false });
  });
  it('never charges more than the balance (deposit > balance edge)', () => {
    // total 10000, deposit 3000, but 8000 already paid → balance 2000 < deposit remainder
    expect(computeChargeNow({ depositDue: '9000.00', amountPaid: '8000.00', balance: '2000.00' }))
      .toEqual({ amount: '1000.00', isDeposit: true });
  });
  it('JPY deposit remainder rounds to a whole unit', () => {
    // depositDue 1000.50 can only exist from pre-fix data; the charge amount
    // must still come out representable: 1000.50 - 0 → 1001 (half-up), clamped by balance.
    const r = computeChargeNow({ depositDue: '1000.50', amountPaid: '0.00', balance: '2000.00' }, 'JPY');
    expect(r).toEqual({ amount: '1001.00', isDeposit: true });
  });
  it('omitted currency keeps 2-decimal behavior', () => {
    const r = computeChargeNow({ depositDue: '10.50', amountPaid: '0.00', balance: '20.00' });
    expect(r).toEqual({ amount: '10.50', isDeposit: true });
  });
});

// #3803 item 8: the amount a Stripe Checkout session charges. Stripe takes an
// integer in the currency's minor unit, so a balance the currency cannot express
// (legacy zero-decimal rows such as JPY '1000.50') has no correct charge: rounding
// it up over-charges, rounding it down strands a residue no Checkout can collect.
describe('computeCheckoutCharge', () => {
  const inv = (balance: string, depositDue: string | null = null, amountPaid = '0.00') => ({ depositDue, amountPaid, balance });

  it('2-decimal balance → cents', () => {
    expect(computeCheckoutCharge(inv('1234.56'), 'USD'))
      .toEqual({ kind: 'charge', amount: '1234.56', minor: 123456, isDeposit: false });
  });

  it('zero-decimal balance → whole units, never ×100', () => {
    expect(computeCheckoutCharge(inv('1001.00'), 'JPY'))
      .toEqual({ kind: 'charge', amount: '1001.00', minor: 1001, isDeposit: false });
  });

  it('deposit remainder is charged in minor units', () => {
    expect(computeCheckoutCharge(inv('9000.00', '3000.00', '1000.00'), 'EUR'))
      .toEqual({ kind: 'charge', amount: '2000.00', minor: 200000, isDeposit: true });
  });

  it('legacy JPY deposit with a fraction still charges a whole unit when the balance is representable', () => {
    expect(computeCheckoutCharge(inv('2000.00', '1000.50'), 'JPY'))
      .toEqual({ kind: 'charge', amount: '1001.00', minor: 1001, isDeposit: true });
  });

  it('legacy JPY balance 1000.50 is refused (half-up would charge 1001, 0.50 more than owed)', () => {
    expect(computeCheckoutCharge(inv('1000.50'), 'JPY')).toEqual({ kind: 'not_representable', balance: '1000.50' });
  });

  it('legacy JPY balance 1000.40 is refused (a 1000 charge would strand 0.40)', () => {
    expect(computeCheckoutCharge(inv('1000.40'), 'JPY')).toEqual({ kind: 'not_representable', balance: '1000.40' });
  });

  it('a sub-unit legacy residue is not_representable, not "nothing to pay"', () => {
    expect(computeCheckoutCharge(inv('0.40'), 'JPY')).toEqual({ kind: 'not_representable', balance: '0.40' });
  });

  it('a deposit charge on a non-representable balance is refused too', () => {
    // Charging the 500 deposit would leave 500.50, which no Checkout can collect.
    expect(computeCheckoutCharge(inv('1000.50', '500.00'), 'JPY')).toEqual({ kind: 'not_representable', balance: '1000.50' });
  });

  it('zero or negative balance → nothing', () => {
    expect(computeCheckoutCharge(inv('0.00'), 'USD')).toEqual({ kind: 'nothing' });
    expect(computeCheckoutCharge(inv('-5.00'), 'USD')).toEqual({ kind: 'nothing' });
    expect(computeCheckoutCharge(inv('0.00'), 'JPY')).toEqual({ kind: 'nothing' });
  });

  it('the minor amount sent to Stripe always converts back to the recorded amount', () => {
    const cases: Array<[string, string | null, string, string]> = [
      ['0.01', null, '0.00', 'USD'], ['0.29', null, '0.00', 'USD'], ['19.99', null, '0.00', 'GBP'],
      ['99999999.99', null, '0.00', 'USD'], ['1.00', null, '0.00', 'JPY'], ['123456789.00', null, '0.00', 'KRW'],
      ['10000.00', '3333.33', '0.00', 'USD'], ['5000.00', '2500.50', '0.00', 'JPY'],
    ];
    for (const [balance, depositDue, amountPaid, currency] of cases) {
      const r = computeCheckoutCharge({ balance, depositDue, amountPaid }, currency);
      if (r.kind !== 'charge') throw new Error(`${balance} ${currency}: expected a charge, got ${r.kind}`);
      expect(fromMinorUnits(r.minor, currency)).toBe(r.amount);
      expect(Number.isSafeInteger(r.minor) && r.minor > 0).toBe(true);
    }
  });
});
