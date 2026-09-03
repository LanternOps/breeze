/**
 * #3205 W04 / #4607: the boundary matrix for the ONE definition of how a counted
 * quantity splits into billed + overage. Pure — no DB, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAllowance, billsOverage, overageValue,
  type AllowanceSpec, type ResolvedQuantity,
} from './contractAllowance';

const NONE: AllowanceSpec = { includedQuantity: null, overageMode: null, overageUnitPrice: null };
const BILL: AllowanceSpec = { includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' };
const FLAG: AllowanceSpec = { includedQuantity: '25.00', overageMode: 'flag', overageUnitPrice: null };

describe('applyAllowance — the boundary matrix (#4607)', () => {
  // counted, spec, expected { billed, included, overage, overageMode }, billsOverage
  it.each<[number, string, AllowanceSpec, Omit<ResolvedQuantity, 'counted'>, boolean]>([
    [0,  'none', NONE, { billed: 0,  included: null, overage: 0, overageMode: null }, false],
    [24, 'none', NONE, { billed: 24, included: null, overage: 0, overageMode: null }, false],
    [25, 'none', NONE, { billed: 25, included: null, overage: 0, overageMode: null }, false],
    [26, 'none', NONE, { billed: 26, included: null, overage: 0, overageMode: null }, false],
    // FIXED allowance: the base bills 25 even at counted 0.
    [0,  'bill', BILL, { billed: 25, included: 25, overage: 0, overageMode: 'bill' }, false],
    [24, 'bill', BILL, { billed: 25, included: 25, overage: 0, overageMode: 'bill' }, false],
    [25, 'bill', BILL, { billed: 25, included: 25, overage: 0, overageMode: 'bill' }, false],
    [26, 'bill', BILL, { billed: 25, included: 25, overage: 1, overageMode: 'bill' }, true],
    [0,  'flag', FLAG, { billed: 25, included: 25, overage: 0, overageMode: 'flag' }, false],
    [24, 'flag', FLAG, { billed: 25, included: 25, overage: 0, overageMode: 'flag' }, false],
    [25, 'flag', FLAG, { billed: 25, included: 25, overage: 0, overageMode: 'flag' }, false],
    // flag mode is OVER but never bills — the row that carries the design.
    [26, 'flag', FLAG, { billed: 25, included: 25, overage: 1, overageMode: 'flag' }, false],
  ])('counted %d, mode %s', (counted, _mode, spec, expected, bills) => {
    const r = applyAllowance(counted, spec, 'included_units');
    expect(r).toEqual({ counted, ...expected });
    expect(billsOverage(r)).toBe(bills);
  });

  it('no allowance is the identity under included_units', () => {
    for (const counted of [0, 1, 7, 1000]) {
      expect(applyAllowance(counted, NONE, 'included_units')).toEqual({
        counted, billed: counted, included: null, overage: 0, overageMode: null,
      });
    }
  });

  it('treats an absent includedQuantity column as no allowance', () => {
    expect(applyAllowance(7, { ...NONE, includedQuantity: undefined as never }, 'included_units')).toEqual({
      counted: 7, billed: 7, included: null, overage: 0, overageMode: null,
    });
  });

  // The #4547 (block hours) contract: unit_price is the price of the whole block,
  // so the base quantity is 1 whether or not there is an allowance.
  it.each<[string, AllowanceSpec, number | null]>([
    ['without an allowance', NONE, null],
    ['with a bill allowance', { includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00' }, 10],
    ['with a flag allowance', { includedQuantity: '10.00', overageMode: 'flag', overageUnitPrice: null }, 10],
  ])('single_block always bills 1 %s', (_name, spec, included) => {
    for (const counted of [0, 9, 10, 11]) {
      const r = applyAllowance(counted, spec, 'single_block');
      expect(r.billed).toBe(1);
      expect(r.included).toBe(included);
      expect(r.overage).toBe(included === null ? 0 : Math.max(0, counted - included));
    }
  });

  it('a fractional includedQuantity parses (hours stay usable for #4547)', () => {
    const r = applyAllowance(9.25, { includedQuantity: '7.50', overageMode: 'bill', overageUnitPrice: '150.00' }, 'single_block');
    expect(r).toEqual({ counted: 9.25, billed: 1, included: 7.5, overage: 1.75, overageMode: 'bill' });
  });
});

describe('overageValue — exact decimal money (#4607)', () => {
  const over = (overage: number, mode: 'bill' | 'flag' = 'bill'): ResolvedQuantity =>
    ({ counted: 25 + overage, billed: 25, included: 25, overage, overageMode: mode });

  // A double gets this wrong: 0.02 * 7.25 === 0.14499999999999999 -> '0.14'.
  // multiplyToCurrency works in scaled-integer space: 0.145 -> half-up -> '0.15'.
  it('rounds half-up on the EXACT decimal, not on a double', () => {
    expect(overageValue(over(0.02), { overageUnitPrice: '7.25' }, 'USD')).toBe('0.15');
  });

  it('multiplies a whole overage at the stamped rate', () => {
    expect(overageValue(over(3), { overageUnitPrice: '12.00' }, 'USD')).toBe('36.00');
  });

  it('is the currency-scaled zero when nothing is billed', () => {
    expect(overageValue(over(0), { overageUnitPrice: '12.00' }, 'USD')).toBe('0.00');
    expect(overageValue(over(2, 'flag'), { overageUnitPrice: '12.00' }, 'USD')).toBe('0.00');
    expect(overageValue(over(0), { overageUnitPrice: null }, 'JPY')).toBe('0.00');
  });

  it('respects a zero-decimal currency', () => {
    expect(overageValue(over(1), { overageUnitPrice: '300.4' }, 'JPY')).toBe('300.00');
  });

  it('an overage rate of 0 is itemised at no charge, not skipped', () => {
    const r = over(1);
    expect(billsOverage(r)).toBe(true);
    expect(overageValue(r, { overageUnitPrice: '0.00' }, 'USD')).toBe('0.00');
  });
});
