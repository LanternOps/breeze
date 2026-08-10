import { describe, expect, it } from 'vitest';
import { SUPPORT_CODE_ALPHABET, SUPPORT_CODE_LENGTH, SUPPORT_CODE_PATTERN } from '@breeze/shared';
import {
  SUPPORT_CODE_TTL_MINUTES,
  SUPPORT_SESSION_HARD_CAP_HOURS,
  generateSupportCode,
  hashSupportCode,
} from './quickSupportCode';

describe('generateSupportCode', () => {
  it('produces a code matching the shared pattern', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateSupportCode();
      expect(code).toHaveLength(SUPPORT_CODE_LENGTH);
      expect(SUPPORT_CODE_PATTERN.test(code)).toBe(true);
    }
  });

  // SUPPORT_CODE_PATTERN is deliberately permissive (it still accepts legacy
  // letters+digits codes), so it alone would NOT catch a regression that let
  // letters back into generation. Assert the mint alphabet directly.
  it('mints digits 2-9 only, so the code reads aloud like a phone number', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSupportCode()).toMatch(/^[2-9]{9}$/);
    }
  });

  it('can emit every symbol in the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      for (const ch of generateSupportCode()) seen.add(ch);
    }
    expect([...seen].sort().join('')).toBe([...SUPPORT_CODE_ALPHABET].sort().join(''));
  });

  // Not a statistical test — just a smoke check that we aren't returning a
  // constant or seeding from something fixed. 8^9 is ~134M, so 1000 draws
  // collide with probability well under 1e-3.
  it('does not repeat itself across a thousand generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSupportCode());
    expect(seen.size).toBeGreaterThan(990);
  });
});

describe('hashSupportCode', () => {
  it('returns a stable lowercase 64-character hex digest', () => {
    const first = hashSupportCode('KTM4H7P2X');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSupportCode('KTM4H7P2X')).toBe(first);
  });

  it('is case- and value-sensitive', () => {
    expect(hashSupportCode('KTM4H7P2X')).not.toBe(hashSupportCode('ktm4h7p2x'));
    expect(hashSupportCode('KTM4H7P2X')).not.toBe(hashSupportCode('KTM4H7P2Y'));
  });
});

describe('lifetime constants', () => {
  it('keeps the redemption window short and the hard cap under a day', () => {
    expect(SUPPORT_CODE_TTL_MINUTES).toBe(15);
    expect(SUPPORT_SESSION_HARD_CAP_HOURS).toBe(8);
  });
});
