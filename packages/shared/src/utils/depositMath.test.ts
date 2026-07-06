// packages/shared/src/utils/depositMath.test.ts
import { describe, it, expect } from 'vitest';
import { computeChargeNow } from './depositMath';

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
});
