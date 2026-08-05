import { describe, expect, it } from 'vitest';
import {
  SUPPORT_CODE_ALPHABET,
  SUPPORT_CODE_LENGTH,
  SUPPORT_CODE_PATTERN,
  createSupportSessionSchema,
  formatSupportCode,
  normalizeSupportCode,
  redeemSupportSessionSchema,
} from './quickSupport';

describe('SUPPORT_CODE_ALPHABET', () => {
  it('excludes the visually ambiguous characters I, L, O, 0 and 1', () => {
    for (const ch of ['I', 'L', 'O', '0', '1']) {
      expect(SUPPORT_CODE_ALPHABET).not.toContain(ch);
    }
  });

  it('has no duplicate characters', () => {
    expect(new Set(SUPPORT_CODE_ALPHABET).size).toBe(SUPPORT_CODE_ALPHABET.length);
  });

  // 30^9 ~= 2^44. The 15-minute TTL plus per-IP rate limiting is what makes
  // this safe; if the alphabet ever shrinks, revisit both.
  it('keeps at least ~44 bits of entropy at the configured length', () => {
    const bits = Math.log2(SUPPORT_CODE_ALPHABET.length) * SUPPORT_CODE_LENGTH;
    expect(bits).toBeGreaterThanOrEqual(44);
  });
});

describe('normalizeSupportCode', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalizeSupportCode('ktm-4h7 p2x')).toBe('KTM4H7P2X');
    expect(normalizeSupportCode('KTM-4H7-P2X')).toBe('KTM4H7P2X');
    expect(normalizeSupportCode('  ktm4h7p2x  ')).toBe('KTM4H7P2X');
  });

  it('rejects codes containing characters outside the alphabet', () => {
    expect(normalizeSupportCode('KTM4H7P20')).toBeNull(); // 0
    expect(normalizeSupportCode('KTM4H7P2I')).toBeNull(); // I
    expect(normalizeSupportCode('KTM4H7P2!')).toBeNull();
  });

  it('rejects codes of the wrong length', () => {
    expect(normalizeSupportCode('KTM4H7P2')).toBeNull(); // 8
    expect(normalizeSupportCode('KTM4H7P2XY')).toBeNull(); // 10
    expect(normalizeSupportCode('')).toBeNull();
  });

  it('accepts every character in the alphabet', () => {
    for (const ch of SUPPORT_CODE_ALPHABET) {
      expect(normalizeSupportCode(ch.repeat(SUPPORT_CODE_LENGTH))).toBe(
        ch.repeat(SUPPORT_CODE_LENGTH),
      );
    }
  });
});

describe('formatSupportCode', () => {
  it('groups the code into three triples', () => {
    expect(formatSupportCode('KTM4H7P2X')).toBe('KTM-4H7-P2X');
  });

  it('round-trips through normalizeSupportCode', () => {
    expect(normalizeSupportCode(formatSupportCode('KTM4H7P2X'))).toBe('KTM4H7P2X');
  });
});

describe('SUPPORT_CODE_PATTERN', () => {
  it('matches a normalized code and nothing else', () => {
    expect(SUPPORT_CODE_PATTERN.test('KTM4H7P2X')).toBe(true);
    expect(SUPPORT_CODE_PATTERN.test('KTM-4H7-P2X')).toBe(false);
    expect(SUPPORT_CODE_PATTERN.test('ktm4h7p2x')).toBe(false);
  });
});

describe('createSupportSessionSchema', () => {
  it('accepts an empty payload — attribution is entirely optional', () => {
    expect(createSupportSessionSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a valid attribution', () => {
    const result = createSupportSessionSchema.safeParse({
      attributedOrgId: '11111111-1111-4111-8111-111111111111',
      attributionLabel: 'Contoso — CFO laptop',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid attributedOrgId', () => {
    expect(createSupportSessionSchema.safeParse({ attributedOrgId: 'nope' }).success).toBe(false);
  });

  it('rejects an over-long attribution label', () => {
    expect(
      createSupportSessionSchema.safeParse({ attributionLabel: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('redeemSupportSessionSchema', () => {
  it('accepts a formatted code plus client details', () => {
    const result = redeemSupportSessionSchema.safeParse({
      code: 'KTM-4H7-P2X',
      hostname: 'DESKTOP-ABC123',
      osType: 'windows',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown osType', () => {
    expect(
      redeemSupportSessionSchema.safeParse({
        code: 'KTM4H7P2X',
        hostname: 'host',
        osType: 'freebsd',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty hostname', () => {
    expect(
      redeemSupportSessionSchema.safeParse({ code: 'KTM4H7P2X', hostname: '', osType: 'macos' })
        .success,
    ).toBe(false);
  });

  it('rejects a code too short to ever normalize', () => {
    expect(
      redeemSupportSessionSchema.safeParse({ code: 'KTM', hostname: 'host', osType: 'windows' })
        .success,
    ).toBe(false);
  });
});
