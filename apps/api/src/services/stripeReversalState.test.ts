import { expect, it } from 'vitest';
import { allocateReversal } from './autopay/refundAllocation';
import { fromMinorUnits, toMinorUnits } from './stripeMoney';
it.each([
  [300, 18, 9983], [300, 36, 9965], [300, 103, 9900],
  [300, 100, 9903], [300, 300, 9709], [300, 10299, 1],
  [300, 10300, 0], [300, 12000, 0], [null, 1, 9999], [null, 10000, 0],
] as const)('C3 fee %s and cumulative refund %s leave %s principal cents', (fee, refund, remaining) => {
  // The reducer bounds combined refunds/disputes to gross before allocation.
  const gross = 10000 + (fee ?? 0);
  const allocation = allocateReversal({
    principal: '100.00', fee: fromMinorUnits(fee ?? 0, 'USD'),
    cumulativeReversedGross: fromMinorUnits(Math.max(0, Math.min(gross, refund)), 'USD'),
  });
  expect(10000 - toMinorUnits(allocation.principalReversed, 'USD')).toBe(remaining);
});
