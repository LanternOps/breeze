import { describe, expect, it } from 'vitest';
import { autopayCapReason } from './authorizedCap';

const usd = (amount: string) => ({ enabled: true as const, amount, currency: 'USD' });
const off = { enabled: false as const };

describe('autopayCapReason: the effective cap is the lower of current and accepted (R5)', () => {
  it('reports an accepted cap in another currency as a currency mismatch, even with no current cap', () => {
    expect(autopayCapReason({ current: off, accepted: { enabled: true, amount: '100.00', currency: 'EUR' }, total: '10.00', currency: 'USD' }))
      .toBe('cap_currency_mismatch');
  });
  it('compares currencies case-insensitively', () => {
    expect(autopayCapReason({ current: off, accepted: { enabled: true, amount: '100.00', currency: 'usd' }, total: '10.00', currency: 'USD' }))
      .toBeNull();
  });
  it('admits a total exactly equal to either cap', () => {
    expect(autopayCapReason({ current: usd('100.00'), accepted: off, total: '100.00', currency: 'USD' })).toBeNull();
    expect(autopayCapReason({ current: off, accepted: usd('100.00'), total: '100.00', currency: 'USD' })).toBeNull();
    expect(autopayCapReason({ current: usd('100.00'), accepted: usd('100.00'), total: '100.00', currency: 'USD' })).toBeNull();
  });
  it('refuses one minor unit over, naming the side that binds', () => {
    expect(autopayCapReason({ current: usd('100.00'), accepted: off, total: '100.01', currency: 'USD' })).toBe('over_cap');
    expect(autopayCapReason({ current: usd('500.00'), accepted: usd('100.00'), total: '100.01', currency: 'USD' })).toBe('above_authorized_cap');
    expect(autopayCapReason({ current: off, accepted: usd('100.00'), total: '100.01', currency: 'USD' })).toBe('above_authorized_cap');
  });
  it('compares a zero-decimal currency in whole units', () => {
    const jpy = (amount: string) => ({ enabled: true as const, amount, currency: 'JPY' });
    expect(autopayCapReason({ current: off, accepted: jpy('10000'), total: '10000', currency: 'JPY' })).toBeNull();
    expect(autopayCapReason({ current: off, accepted: jpy('10000'), total: '10001', currency: 'JPY' })).toBe('above_authorized_cap');
    expect(autopayCapReason({ current: jpy('5000'), accepted: jpy('10000'), total: '5001', currency: 'JPY' })).toBe('over_cap');
  });
  it('treats two disabled caps as no limit', () => {
    expect(autopayCapReason({ current: off, accepted: off, total: '999999.99', currency: 'USD' })).toBeNull();
  });
});
