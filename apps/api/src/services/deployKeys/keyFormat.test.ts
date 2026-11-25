import { describe, expect, it } from 'vitest';
import { hashEnrollmentKey } from '../enrollmentKeySecurity';
import {
  DEPLOY_KEY_PREFIX,
  deployKeyHashCandidates,
  generateDeployKey,
  hashDeployKey,
  hasDeployKeyPrefix,
  isWellFormedDeployKey,
} from './keyFormat';

describe('deploy key format', () => {
  it('generates bdk_ + 64 lowercase hex, fresh every time', () => {
    const a = generateDeployKey();
    const b = generateDeployKey();
    expect(a).toMatch(/^bdk_[0-9a-f]{64}$/);
    expect(a).toHaveLength(DEPLOY_KEY_PREFIX.length + 64);
    expect(a).not.toBe(b);
    expect(isWellFormedDeployKey(a)).toBe(true);
  });

  it.each([
    ['an org enrollment key (bare 64 hex)', 'a'.repeat(64), false, false],
    ['a well-formed deploy key', `bdk_${'0f'.repeat(32)}`, true, true],
    ['a short deploy key', `bdk_${'a'.repeat(63)}`, true, false],
    ['a long deploy key', `bdk_${'a'.repeat(65)}`, true, false],
    ['uppercase hex', `bdk_${'A'.repeat(64)}`, true, false],
    ['non-hex', `bdk_${'g'.repeat(64)}`, true, false],
    ['the bare prefix', 'bdk_', true, false],
    ['an uppercase prefix', `BDK_${'a'.repeat(64)}`, false, false],
    ['a prefix after whitespace', ` bdk_${'a'.repeat(64)}`, false, false],
    ['empty', '', false, false],
  ])('%s: routed=%s, well-formed=%s', (_label, raw, routed, wellFormed) => {
    expect(hasDeployKeyPrefix(raw)).toBe(routed);
    expect(isWellFormedDeployKey(raw)).toBe(wellFormed);
  });

  it('hashes the whole string (prefix included) with the peppered enrollment-key helper', () => {
    const raw = generateDeployKey();
    const hash = hashDeployKey(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashEnrollmentKey(raw));
    expect(hash).not.toBe(hashEnrollmentKey(raw.slice(DEPLOY_KEY_PREFIX.length)));
    expect(hash).not.toContain(raw.slice(DEPLOY_KEY_PREFIX.length));
  });

  it('lookup candidates start with the stored hash', () => {
    const raw = generateDeployKey();
    expect(deployKeyHashCandidates(raw)[0]).toBe(hashDeployKey(raw));
  });
});
