/**
 * Exact decimal arithmetic for AI chargeback (#7608). Normative rounding rules
 * RR1/RR2 in the W10 plan: every per-invocation amount is computed exactly in
 * BigInt and rounded ONCE, half-up, to 6 decimal places. No binary float ever
 * touches a client price.
 */
import type { TokenComponents } from '../aiModels/pricing';
import type { AiRatePrices } from './chargeTerms';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const PER_MILLION = 1_000_000n;

/** A non-negative decimal string → integer scaled by 10^scale. Digits beyond
 *  `scale` must be zeros (inputs are schema-validated); anything else throws. */
export function toScaled(value: string, scale: number): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`chargeMath: not a non-negative decimal: ${value}`);
  const frac = match[2] ?? '';
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) {
    throw new Error(`chargeMath: ${value} has more than ${scale} decimals`);
  }
  const fracDigits = frac.slice(0, scale).padEnd(scale, '0');
  return BigInt(match[1]!) * 10n ** BigInt(scale) + (fracDigits ? BigInt(fracDigits) : 0n);
}

/** n / d rounded half up; both non-negative. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error('chargeMath: divHalfUp needs n >= 0 and d > 0');
  const q = n / d;
  return (n % d) * 2n >= d ? q + 1n : q;
}

export function formatScaled(value: bigint, scale: number): string {
  if (value < 0n) throw new Error('chargeMath: negative amount');
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** RR1: Σ tokens_k × rate_k / 1e6, rates per million tokens (≤ 6 dp). */
export function priceListAmount(tokens: TokenComponents, rates: AiRatePrices): string {
  const n = BigInt(tokens.input) * toScaled(rates.inputPricePerM, 6)
    + BigInt(tokens.output) * toScaled(rates.outputPricePerM, 6)
    + BigInt(tokens.cacheRead) * toScaled(rates.cacheReadPricePerM, 6)
    + BigInt(tokens.cacheWrite) * toScaled(rates.cacheWritePricePerM, 6);
  // n = amount × 1e6 (rate scale) × 1e6 (per-million) → amount at 6 dp = n / 1e6
  return formatScaled(divHalfUp(n, PER_MILLION), 6);
}

/** RR2: cost_cents × (100 + markup%) / 10,000, in currency major units. */
export function markupAmount(costCents: number, markupPercent: string): string {
  if (!Number.isFinite(costCents) || costCents < 0) throw new Error('chargeMath: cost must be a finite non-negative number');
  const cents6 = toScaled(costCents.toFixed(6), 6); // cents × 1e6 (cost_cents is numeric(20,6))
  const percent2 = toScaled(markupPercent, 2);       // percent × 100
  // amount = cents/100 × (10000 + percent2)/10000 → amount×1e6 = cents6 × (10000 + percent2) / 1e6
  return formatScaled(divHalfUp(cents6 * (10_000n + percent2), PER_MILLION), 6);
}
