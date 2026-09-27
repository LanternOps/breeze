import { describe, expect, it } from 'vitest';
import {
  MAX_SUCCESS_EXIT_CODES,
  parseSuccessExitCodesText,
  successExitCodesSchema,
} from './softwareExitCodes';

describe('successExitCodesSchema (#7038)', () => {
  it('accepts vendor codes and returns them deduped and sorted', () => {
    expect(successExitCodesSchema.parse([1101, 1000, 1000])).toEqual([1000, 1101]);
  });

  it('folds a signed HRESULT spelling onto its unsigned DWORD bits', () => {
    // 0x80070005 = -2147024891 signed = 2147942405 unsigned
    expect(successExitCodesSchema.parse([-2147024891, 2147942405])).toEqual([2147942405]);
  });

  it('accepts the uint32 and int32 extremes', () => {
    expect(successExitCodesSchema.parse([4294967295, -2147483648])).toEqual([2147483648, 4294967295]);
  });

  it.each([
    ['non-integer', [1.5]],
    ['above uint32', [4294967296]],
    ['below int32', [-2147483649]],
    ['string', ['1000']],
  ])('rejects %s', (_label, value) => {
    expect(successExitCodesSchema.safeParse(value).success).toBe(false);
  });

  it(`rejects more than ${MAX_SUCCESS_EXIT_CODES} codes`, () => {
    const tooMany = Array.from({ length: MAX_SUCCESS_EXIT_CODES + 1 }, (_, i) => 1000 + i);
    expect(successExitCodesSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('parseSuccessExitCodesText', () => {
  it('parses comma/space separated decimal and hex', () => {
    expect(parseSuccessExitCodesText('1000, 1101 0x80070005')).toEqual({
      ok: true,
      codes: [1000, 1101, 2147942405],
    });
  });

  it('treats blank as no codes', () => {
    expect(parseSuccessExitCodesText('   ')).toEqual({ ok: true, codes: [] });
  });

  it('reports the offending token', () => {
    const result = parseSuccessExitCodesText('1000, abc');
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, invalidToken: 'abc' });
  });

  it('reports too many codes distinctly', () => {
    const text = Array.from({ length: MAX_SUCCESS_EXIT_CODES + 1 }, (_, i) => 1000 + i).join(',');
    expect(parseSuccessExitCodesText(text)).toEqual({ ok: false, tooMany: true });
  });

  it('rejects out-of-range values', () => {
    expect(parseSuccessExitCodesText('4294967296').ok).toBe(false);
  });
});
