import { describe, expect, it } from 'vitest';
import { SUPPORT_CODE_LENGTH, SUPPORT_CODE_PATTERN } from '@breeze/shared';
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

  // Not a statistical test — just a smoke check that we aren't returning a
  // constant or seeding from something fixed.
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
