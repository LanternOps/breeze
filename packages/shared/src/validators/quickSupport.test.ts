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
  it('is digits 2-9 only, so the code reads aloud like a phone number', () => {
    expect(SUPPORT_CODE_ALPHABET).toBe('23456789');
  });

  it('excludes the visually ambiguous characters 0 and 1 (and every letter)', () => {
    for (const ch of ['0', '1']) {
      expect(SUPPORT_CODE_ALPHABET).not.toContain(ch);
    }
    expect(SUPPORT_CODE_ALPHABET).toMatch(/^[2-9]+$/);
  });

  it('has no duplicate characters', () => {
    expect(new Set(SUPPORT_CODE_ALPHABET).size).toBe(SUPPORT_CODE_ALPHABET.length);
  });

  // Already-released agent binaries pull the code out of the download filename
  // with `[a-z2-9]{9}`. A mint alphabet straying outside that set would strand
  // every client in the wild, so this is a hard compatibility floor.
  it('stays inside the [a-z2-9] set the released agent binaries can parse', () => {
    expect(SUPPORT_CODE_ALPHABET.toLowerCase()).toMatch(/^[a-z2-9]+$/);
  });

  // 8^9 ~= 2^27 (~134M). Deliberately down from the previous ~44 bits: the
  // 15-minute TTL, hash-only storage and per-IP rate limits on /support/check
  // (30/min) and /support/redeem (10/min) are what bound guessing. If any of
  // those is relaxed, raise SUPPORT_CODE_LENGTH rather than widening this.
  it('keeps at least ~27 bits of entropy at the configured length', () => {
    const bits = Math.log2(SUPPORT_CODE_ALPHABET.length) * SUPPORT_CODE_LENGTH;
    expect(bits).toBeGreaterThanOrEqual(27);
  });
});

describe('normalizeSupportCode', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalizeSupportCode('234-567 892')).toBe('234567892');
    expect(normalizeSupportCode('234-567-892')).toBe('234567892');
    expect(normalizeSupportCode('  234567892  ')).toBe('234567892');
  });

  // Validation is deliberately wider than generation: a code minted before a
  // rolling deploy must still check and redeem against the new API.
  it('still accepts a legacy letters+digits code', () => {
    expect(normalizeSupportCode('ktm-4h7 p2x')).toBe('KTM4H7P2X');
    expect(normalizeSupportCode('KTM-4H7-P2X')).toBe('KTM4H7P2X');
    expect(normalizeSupportCode('KTM4H7P2X')).toBe('KTM4H7P2X');
  });

  it('rejects codes containing characters outside the pattern', () => {
    expect(normalizeSupportCode('234567890')).toBeNull(); // 0
    expect(normalizeSupportCode('234567891')).toBeNull(); // 1
    expect(normalizeSupportCode('23456789!')).toBeNull();
  });

  it('rejects codes of the wrong length', () => {
    expect(normalizeSupportCode('23456789')).toBeNull(); // 8
    expect(normalizeSupportCode('2345678923')).toBeNull(); // 10
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
    expect(formatSupportCode('234567892')).toBe('234-567-892');
  });

  it('round-trips through normalizeSupportCode', () => {
    expect(normalizeSupportCode(formatSupportCode('234567892'))).toBe('234567892');
    expect(normalizeSupportCode(formatSupportCode('KTM4H7P2X'))).toBe('KTM4H7P2X');
  });
});

describe('SUPPORT_CODE_PATTERN', () => {
  it('matches a normalized code and nothing else', () => {
    expect(SUPPORT_CODE_PATTERN.test('234567892')).toBe(true);
    expect(SUPPORT_CODE_PATTERN.test('234-567-892')).toBe(false);
    expect(SUPPORT_CODE_PATTERN.test('23456789')).toBe(false);
  });

  it('still matches a legacy letters+digits code', () => {
    expect(SUPPORT_CODE_PATTERN.test('KTM4H7P2X')).toBe(true);
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
      code: '234-567-892',
      hostname: 'DESKTOP-ABC123',
      osType: 'windows',
    });
    expect(result.success).toBe(true);
  });

  it('still accepts a legacy letters+digits code minted before the switch', () => {
    expect(
      redeemSupportSessionSchema.safeParse({
        code: 'KTM-4H7-P2X',
        hostname: 'DESKTOP-ABC123',
        osType: 'windows',
      }).success,
    ).toBe(true);
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
