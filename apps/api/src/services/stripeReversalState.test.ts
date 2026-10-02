import { expect, it } from 'vitest';
import { remainingPrincipalMinor } from './stripeReversalState';
it.each([
  [300, 18, 9983], [300, 36, 9965], [300, 103, 9900],
  [300, 100, 9903], [300, 300, 9709], [300, 10299, 1],
  [300, 10300, 0], [300, 12000, 0], [null, 1, 9999], [null, 10000, 0],
] as const)('C3 fee %s and cumulative refund %s leave %s principal cents', (fee, refund, remaining) => {
  expect(remainingPrincipalMinor(10000, fee, refund)).toBe(remaining);
});
