import { describe, expect, it } from 'vitest';
import {
  canTransition, formatRecoveryCode, generateRecoveryCode, generateRecoveryNonce, hashRecoveryCode,
  isOverdue, normalizeRecoveryCode, RECOVERY_CODE_ALPHABET,
} from './bareMetalRecoveryCodes';

describe('recovery codes', () => {
  it('generates 9 chars from the unambiguous alphabet and formats as XXX-XXX-XXX', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRecoveryCode();
      expect(code).toHaveLength(9);
      for (const ch of code) expect(RECOVERY_CODE_ALPHABET).toContain(ch);
      expect(formatRecoveryCode(code)).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    }
  });
  it('normalizes user input and rejects anything that is not exactly nine alphabet chars', () => {
    expect(normalizeRecoveryCode(' abc-def-ghj ')).toBe('ABCDEFGHJ');
    expect(normalizeRecoveryCode('ABC DEF GHJ')).toBe('ABCDEFGHJ');
    expect(normalizeRecoveryCode('ABC-DEF-GH0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRecoveryCode('ABCDEFGH')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });
  it('hashes deterministically with sha256', () => {
    expect(hashRecoveryCode('ABCDEFGHJ')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode('ABCDEFGHJ')).toBe(hashRecoveryCode('ABCDEFGHJ'));
  });
  it('nonce is 64 hex chars and unique', () => {
    const a = generateRecoveryNonce(); const b = generateRecoveryNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(a).not.toBe(b);
  });
  it('state machine is forward-only with failed/refused from any non-terminal state', () => {
    expect(canTransition('created', 'media_booted')).toBe(true);
    expect(canTransition('media_booted', 'planned')).toBe(true);
    expect(canTransition('planned', 'restoring')).toBe(true);
    expect(canTransition('restoring', 'validated')).toBe(true);
    expect(canTransition('validated', 'rebooted')).toBe(true);
    expect(canTransition('rebooted', 'checked_in')).toBe(true);
    expect(canTransition('created', 'restoring')).toBe(true);   // skipping forward is allowed (lost progress posts)
    expect(canTransition('restoring', 'planned')).toBe(false);  // never backwards
    expect(canTransition('restoring', 'failed')).toBe(true);
    expect(canTransition('created', 'refused')).toBe(true);
    expect(canTransition('checked_in', 'failed')).toBe(false);
    expect(canTransition('completed', 'rebooted')).toBe(false);
    expect(canTransition('validated', 'completed')).toBe(true);
  });
  it('overdue only for rebooted older than 30 minutes', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    expect(isOverdue('rebooted', new Date('2026-09-10T11:20:00Z'), now)).toBe(true);
    expect(isOverdue('rebooted', new Date('2026-09-10T11:45:00Z'), now)).toBe(false);
    expect(isOverdue('validated', new Date('2026-09-10T10:00:00Z'), now)).toBe(false);
    expect(isOverdue('checked_in', new Date('2026-09-10T10:00:00Z'), now)).toBe(false);
  });
});
