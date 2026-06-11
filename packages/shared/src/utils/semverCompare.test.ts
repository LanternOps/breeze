import { describe, it, expect } from 'vitest';
import { semverCompare } from './semverCompare';

describe('semverCompare', () => {
  it('returns 0 for equal versions', () => {
    expect(semverCompare('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns negative when a < b at patch level', () => {
    expect(semverCompare('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('returns negative when a < b at minor level', () => {
    expect(semverCompare('1.2.9', '1.3.0')).toBeLessThan(0);
  });

  it('returns negative when a < b at major level', () => {
    expect(semverCompare('1.9.9', '2.0.0')).toBeLessThan(0);
  });

  it('returns positive when a > b at patch level', () => {
    expect(semverCompare('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  it('returns positive when a > b at minor level', () => {
    expect(semverCompare('1.3.0', '1.2.9')).toBeGreaterThan(0);
  });

  it('returns positive when a > b at major level', () => {
    expect(semverCompare('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('ignores prerelease suffix when comparing', () => {
    expect(semverCompare('0.65.10-dev', '0.65.10')).toBe(0);
    expect(semverCompare('0.65.10', '0.65.10-rc1')).toBe(0);
    expect(semverCompare('0.65.11-dev', '0.65.10')).toBeGreaterThan(0);
  });

  it('handles multi-digit components', () => {
    expect(semverCompare('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(semverCompare('10.0.0', '9.99.99')).toBeGreaterThan(0);
  });

  it('returns null for unparseable input', () => {
    expect(semverCompare('not-a-version', '1.2.3')).toBeNull();
    expect(semverCompare('1.2.3', 'invalid')).toBeNull();
    expect(semverCompare('', '1.2.3')).toBeNull();
    expect(semverCompare('1.2', '1.2.3')).toBeNull();
  });
});
