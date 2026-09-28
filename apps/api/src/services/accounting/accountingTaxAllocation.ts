/**
 * Spreads an invoice-level tax total over its lines (Xero W04, spec "Tax
 * allocation"). Breeze stores tax as ONE figure computed on the taxable,
 * customer-visible lines (invoiceMath.computeInvoiceTotals); a provider that
 * records tax per line needs each line's share, and the shares must sum to
 * exactly the figure the customer was billed.
 *
 * Method: pro rata to each taxed line's total, in the currency's MINOR unit
 * (cents; whole units for zero-decimal currencies), largest remainder, ties to
 * the earliest line. BigInt throughout, so neither float rounding nor a 2^53
 * overflow (tax × weight on a large invoice) can move a cent.
 *
 * Returns null — never a best guess — when the tax cannot be placed: a
 * non-zero tax with no taxed weight (or weights that net to zero), or an
 * amount that is unreadable or finer than the currency's minor unit.
 */
import { minorUnitExponent } from '@breeze/shared';

export interface TaxAllocationLine {
  lineTotal: string;
  /** The line carries tax (the caller decides: taxable AND the invoice's tax is non-zero). */
  taxed: boolean;
}

function toMinor(value: string, exp: 0 | 2): bigint | null {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  if (/[1-9]/.test(frac.slice(exp))) return null; // finer than the currency's minor unit
  const minor = BigInt(`${m[2]}${frac.slice(0, exp).padEnd(exp, '0')}`);
  return m[1] ? -minor : minor;
}

function fromMinor(minor: bigint, exp: 0 | 2): string {
  const sign = minor < 0n ? '-' : '';
  const abs = minor < 0n ? -minor : minor;
  if (exp === 0) return `${sign}${abs}`;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Floor division for BigInt (the `/` operator truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export function isZeroAmount(value: string): boolean {
  return /^-?0+(?:\.0+)?$/.test(value.trim());
}

export function allocateInvoiceTax(
  taxTotal: string,
  lines: readonly TaxAllocationLine[],
  currencyCode: string,
): string[] | null {
  const exp = minorUnitExponent(currencyCode);
  const tax = toMinor(taxTotal, exp);
  // Line totals are numeric(12,2) in every currency; their scale only sets the weights.
  const weights = lines.map((l) => (l.taxed ? toMinor(l.lineTotal, 2) : 0n));
  if (tax === null || weights.some((w) => w === null)) return null;
  if (tax === 0n) return lines.map(() => fromMinor(0n, exp));

  const w = weights as bigint[];
  const total = w.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;

  // Normalise to a positive divisor; the math is sign-agnostic after that.
  const sign = total < 0n ? -1n : 1n;
  const divisor = total * sign;
  const floors = w.map((wi) => floorDiv(tax * wi * sign, divisor));
  const remainders = w.map((wi, i) => tax * wi * sign - floors[i]! * divisor);
  let left = tax - floors.reduce((a, b) => a + b, 0n); // 0 ≤ left < number of taxed lines
  const order = w
    .map((_, i) => i)
    .filter((i) => lines[i]!.taxed)
    .sort((a, b) => (remainders[b]! > remainders[a]! ? 1 : remainders[b]! < remainders[a]! ? -1 : a - b));
  const shares = [...floors];
  for (const i of order) {
    if (left <= 0n) break;
    shares[i] = shares[i]! + 1n;
    left -= 1n;
  }
  return shares.map((s) => fromMinor(s, exp));
}
