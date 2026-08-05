import { describe, expect, it } from 'vitest';
import { deriveLineFulfillment } from './quoteFulfillment';

const a = (orderedQty: string, receivedQty: string, cancelledAt: string | null = null) =>
  ({ orderedQty, receivedQty, cancelledAt });

describe('deriveLineFulfillment', () => {
  it('not_ordered when no allocations or all cancelled', () => {
    expect(deriveLineFulfillment([])).toBe('not_ordered');
    expect(deriveLineFulfillment([a('2.00', '0', '2026-08-01T00:00:00Z')])).toBe('not_ordered');
  });
  it('ordered when nothing received', () => {
    expect(deriveLineFulfillment([a('2.00', '0')])).toBe('ordered');
  });
  it('partially_received across multiple allocations', () => {
    expect(deriveLineFulfillment([a('2.00', '2.00'), a('3.00', '0')])).toBe('partially_received');
  });
  it('received when totals meet, ignoring cancelled allocations', () => {
    expect(deriveLineFulfillment([a('2.00', '2.00'), a('5.00', '0', '2026-08-01T00:00:00Z')])).toBe('received');
  });
  it('handles fractional quantities exactly (cents-scaled integer math)', () => {
    expect(deriveLineFulfillment([a('0.30', '0.10'), a('0.30', '0.20')])).toBe('partially_received');
  });
});
