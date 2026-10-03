function cents(value: string): bigint {
  if (!/^\d{1,11}(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid reversal amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function money(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

/** Allocate from the cumulative gross total so per-event rounding cannot drift. */
export function allocateReversal(input: {
  principal: string;
  fee: string;
  cumulativeReversedGross: string;
}): { principalReversed: string; feeReversed: string } {
  const p = cents(input.principal), f = cents(input.fee), r = cents(input.cumulativeReversedGross);
  const g = p + f;
  if (p > 999999999999n || f > 999999999999n) throw new Error('Invalid reversal amount');
  if (r > g) throw new Error('Reversal exceeds original gross amount');
  if (g === 0n) return { principalReversed: '0.00', feeReversed: '0.00' };
  // Round principal half-up; fee receives the complement, including final residue.
  const allocated = (2n * p * r + g) / (2n * g);
  return { principalReversed: money(allocated), feeReversed: money(r - allocated) };
}
