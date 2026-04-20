import { describe, it, expect } from 'vitest';
import { generateBootstrapToken, BOOTSTRAP_TOKEN_PATTERN } from './installerBootstrapToken';

describe('generateBootstrapToken', () => {
  it('returns a 6-char token of [A-Z0-9]', () => {
    const t = generateBootstrapToken();
    expect(t).toMatch(BOOTSTRAP_TOKEN_PATTERN);
  });

  it('returns 6 chars exactly', () => {
    expect(generateBootstrapToken()).toHaveLength(6);
  });

  it('is statistically unique across 1000 calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(generateBootstrapToken());
    // 36^6 ≈ 2.2B values; collisions in 1000 samples are essentially impossible.
    // Allow a single collision before flagging — defensive against an unlucky CI run.
    expect(tokens.size).toBeGreaterThanOrEqual(999);
  });

  it('emits only uppercase letters and digits', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateBootstrapToken()).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe('BOOTSTRAP_TOKEN_PATTERN', () => {
  it('matches the canonical 6-char form', () => {
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQ')).toBe(true);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('123456')).toBe(true);
  });

  it('rejects shorter, longer, or lowercase variants', () => {
    expect(BOOTSTRAP_TOKEN_PATTERN.test('a7k2xq')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2X')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQA')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7-2XQ')).toBe(false);
  });
});
