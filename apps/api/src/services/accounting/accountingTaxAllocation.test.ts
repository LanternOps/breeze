import { describe, expect, it } from 'vitest';
import { allocateInvoiceTax, isZeroAmount } from './accountingTaxAllocation';

const t = (lineTotal: string, taxed = true) => ({ lineTotal, taxed });
const cents = (v: string) => Math.round(Number(v) * 100);

describe('allocateInvoiceTax', () => {
  it('splits pro rata to line totals', () => {
    expect(allocateInvoiceTax('20.00', [t('100.00'), t('100.00')], 'GBP')).toEqual(['10.00', '10.00']);
  });

  it('gives the rounding cent to the largest remainder, earliest line on a tie', () => {
    // 10.00 over three equal lines: 3.333… each → remainders tie → first line gets the extra cent
    expect(allocateInvoiceTax('10.00', [t('1.00'), t('1.00'), t('1.00')], 'USD')).toEqual(['3.34', '3.33', '3.33']);
    // 1.00 over 1:2 → 0.333 / 0.666 → floors 0.33 + 0.66 = 0.99; the larger remainder (0.666…) takes the cent
    expect(allocateInvoiceTax('1.00', [t('10.00'), t('20.00')], 'USD')).toEqual(['0.33', '0.67']);
  });

  it('untaxed lines get zero and no weight', () => {
    expect(allocateInvoiceTax('7.00', [t('100.00'), t('50.00', false)], 'USD')).toEqual(['7.00', '0.00']);
  });

  it('a zero tax total allocates zero to every line (even taxed ones)', () => {
    expect(allocateInvoiceTax('0.00', [t('100.00'), t('0.00')], 'USD')).toEqual(['0.00', '0.00']);
  });

  it('works in whole units for a zero-decimal currency', () => {
    expect(allocateInvoiceTax('100', [t('1000.00'), t('1000.00'), t('1000.00')], 'JPY')).toEqual(['34', '33', '33']);
  });

  it('handles a negative (discount) taxed line', () => {
    expect(allocateInvoiceTax('18.00', [t('100.00'), t('-10.00')], 'GBP')).toEqual(['20.00', '-2.00']);
  });

  it('refuses when tax exists but no taxed line carries weight', () => {
    expect(allocateInvoiceTax('5.00', [t('100.00', false)], 'USD')).toBeNull();
    expect(allocateInvoiceTax('5.00', [t('0.00'), t('0.00')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('5.00', [t('10.00'), t('-10.00')], 'USD')).toBeNull();
  });

  it('refuses unreadable or over-precise amounts (fail closed)', () => {
    expect(allocateInvoiceTax('abc', [t('1.00')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('1.00', [t('1.005')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('1.50', [t('1000.00')], 'JPY')).toBeNull(); // JPY tax must be whole
  });

  it('stays exact on very large invoices (no float, no 2^53 overflow)', () => {
    const out = allocateInvoiceTax('9999999999.99', [t('9999999999.99'), t('9999999999.99'), t('0.01')], 'USD');
    expect(out).not.toBeNull();
    const sum = out!.reduce((acc, v) => acc + BigInt(v.replace('.', '')), 0n);
    expect(sum).toBe(999999999999n);
  });

  it('property: shares always sum exactly to the tax total and stay within one minor unit of the exact pro-rata share', () => {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let run = 0; run < 500; run++) {
      const n = 1 + Math.floor(rand() * 8);
      const lines = Array.from({ length: n }, () => t((Math.floor(rand() * 500000) / 100).toFixed(2), rand() < 0.75));
      const weight = lines.filter((l) => l.taxed).reduce((a, l) => a + cents(l.lineTotal), 0);
      const tax = (Math.floor(rand() * 100000) / 100).toFixed(2);
      const out = allocateInvoiceTax(tax, lines, 'USD');
      if (weight === 0 && cents(tax) !== 0) { expect(out).toBeNull(); continue; }
      expect(out).not.toBeNull();
      expect(out!.reduce((a, v) => a + cents(v), 0)).toBe(cents(tax));
      out!.forEach((share, i) => {
        if (!lines[i]!.taxed) { expect(cents(share)).toBe(0); return; }
        const exact = weight === 0 ? 0 : (cents(tax) * cents(lines[i]!.lineTotal)) / weight;
        expect(Math.abs(cents(share) - exact)).toBeLessThan(1);
      });
    }
  });
});

describe('isZeroAmount', () => {
  it.each([['0', true], ['0.00', true], ['-0.00', true], ['0.01', false], ['', false], ['abc', false]] as const)('%s → %s', (v, expected) => {
    expect(isZeroAmount(v)).toBe(expected);
  });
});

describe('allocateInvoiceTax — sign paths and exactness beyond the brief', () => {
  it('allocates a negative tax total (credit) pro rata, shares summing exactly', () => {
    expect(allocateInvoiceTax('-10.00', [t('1.00'), t('1.00'), t('1.00')], 'USD')).toEqual(['-3.33', '-3.33', '-3.34']);
    expect(allocateInvoiceTax('-18.00', [t('100.00'), t('-10.00')], 'GBP')).toEqual(['-20.00', '2.00']);
  });

  it('handles weights that net negative (an all-credit invoice)', () => {
    expect(allocateInvoiceTax('-18.00', [t('-100.00'), t('10.00')], 'GBP')).toEqual(['-20.00', '2.00']);
    expect(allocateInvoiceTax('-1.00', [t('-10.00'), t('-20.00')], 'USD')).toEqual(['-0.33', '-0.67']);
  });

  it('never gives the rounding unit to a taxed zero-total line', () => {
    expect(allocateInvoiceTax('1.00', [t('0.00'), t('1.00'), t('1.00'), t('1.00')], 'USD')).toEqual(['0.00', '0.34', '0.33', '0.33']);
  });

  it('ignores the content of untaxed lines but refuses an unreadable taxed line', () => {
    expect(allocateInvoiceTax('1.00', [t('1.00'), t('garbage', false)], 'USD')).toEqual(['1.00', '0.00']);
    expect(allocateInvoiceTax('1.00', [t('1.00'), t('1e2')], 'USD')).toBeNull();
    expect(allocateInvoiceTax('1.00', [t('.50')], 'USD')).toBeNull();
  });

  it('accepts trailing zeros past the minor unit and a negative zero', () => {
    expect(allocateInvoiceTax('1.000', [t('1.0000')], 'USD')).toEqual(['1.00']);
    expect(allocateInvoiceTax('100.00', [t('1.00')], 'JPY')).toEqual(['100']);
    expect(allocateInvoiceTax('-0.00', [t('0.00', false)], 'USD')).toEqual(['0.00']);
  });

  it('property (BigInt, mixed signs, both exponents): exact sum, every taxed share within one minor unit of pro rata, rounding units to the largest remainders', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const toMinor = (v: string, exp: number) => {
      const [i, f = ''] = v.replace('-', '').split('.');
      const m = BigInt(`${i}${f.padEnd(exp, '0').slice(0, exp)}`);
      return v.startsWith('-') ? -m : m;
    };
    for (let run = 0; run < 1000; run++) {
      const currency = rand() < 0.3 ? 'JPY' : 'USD';
      const exp = currency === 'JPY' ? 0 : 2;
      const n = 1 + Math.floor(rand() * 8);
      const negShare = rand(); // per-run mix, so net-negative weight sets (credit invoices) are common
      const lines = Array.from({ length: n }, () => {
        const mag = (Math.floor(rand() * 5_000_000) / 100).toFixed(2);
        return t(rand() < negShare ? `-${mag}` : mag, rand() < 0.75);
      });
      const taxMag = Math.floor(rand() * 1_000_000);
      const taxStr = exp === 0 ? String(taxMag) : (taxMag / 100).toFixed(2);
      const taxText = rand() < 0.2 ? `-${taxStr}` : taxStr;
      const tax = toMinor(taxText, exp);
      const weights = lines.map((l) => (l.taxed ? toMinor(l.lineTotal, 2) : 0n));
      const total = weights.reduce((a, b) => a + b, 0n);
      const out = allocateInvoiceTax(taxText, lines, currency);
      if (total === 0n && tax !== 0n) { expect(out).toBeNull(); continue; }
      expect(out).not.toBeNull();
      const shares = out!.map((s) => toMinor(s, exp));
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(tax);
      const abs = (x: bigint) => (x < 0n ? -x : x);
      const sgn = total < 0n ? -1n : 1n;
      const bumpedFracs: bigint[] = [];
      const keptFracs: bigint[] = [];
      shares.forEach((share, i) => {
        if (!lines[i]!.taxed || tax === 0n) { expect(share).toBe(0n); return; }
        // |share - tax*w/total| < 1  <=>  |share*total - tax*w| < |total|
        const diff = share * total - tax * weights[i]!;
        expect(abs(diff) < abs(total)).toBe(true);
        // Largest remainder: split the exact share into floor + fraction (numerator over |total|).
        const num = tax * weights[i]! * sgn;
        const den = abs(total);
        const floor = num >= 0n || num % den === 0n ? num / den : num / den - 1n;
        const frac = num - floor * den;
        expect(share - floor === 0n || share - floor === 1n).toBe(true);
        (share - floor === 1n ? bumpedFracs : keptFracs).push(frac);
      });
      // Every line that took a rounding unit had a fraction at least as large as every line that did not.
      if (bumpedFracs.length && keptFracs.length) {
        const minBumped = bumpedFracs.reduce((a, b) => (b < a ? b : a));
        const maxKept = keptFracs.reduce((a, b) => (b > a ? b : a));
        expect(minBumped >= maxKept).toBe(true);
      }
    }
  });
});
