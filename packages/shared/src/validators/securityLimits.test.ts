import { describe, expect, it } from 'vitest';
import {
  SECURITY_LIMIT_BOUNDS,
  SECURITY_LIMIT_KEYS,
  SESSION_TIMEOUT_MAX_MINUTES,
  isValidSecurityLimit,
  securityLimitSchemas,
} from './securityLimits';

describe('security limits (#10081)', () => {
  it('minimum password length accepts 6–128 whole numbers only', () => {
    expect(isValidSecurityLimit('minLength', 2)).toBe(false);
    expect(isValidSecurityLimit('minLength', 5)).toBe(false);
    expect(isValidSecurityLimit('minLength', 6)).toBe(true);
    expect(isValidSecurityLimit('minLength', 128)).toBe(true);
    expect(isValidSecurityLimit('minLength', 129)).toBe(false);
    expect(isValidSecurityLimit('minLength', 8.5)).toBe(false);
  });

  it('treats unset (undefined/null) as valid: the field inherits', () => {
    for (const key of SECURITY_LIMIT_KEYS) {
      expect(isValidSecurityLimit(key, undefined)).toBe(true);
      expect(isValidSecurityLimit(key, null)).toBe(true);
    }
  });

  it('session timeout is capped at 12 hours with a readable message', () => {
    expect(SESSION_TIMEOUT_MAX_MINUTES).toBe(720);
    expect(isValidSecurityLimit('sessionTimeout', 720)).toBe(true);
    const r = securityLimitSchemas.sessionTimeout.safeParse(721);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Session timeout cannot exceed 720 minutes (12 hours)');
    expect(isValidSecurityLimit('sessionTimeout', 0)).toBe(false);
  });

  it('expiration days and max sessions enforce only their floor', () => {
    expect(isValidSecurityLimit('expirationDays', 0)).toBe(true);
    expect(isValidSecurityLimit('expirationDays', -1)).toBe(false);
    expect(isValidSecurityLimit('expirationDays', 10_000)).toBe(true);
    expect(isValidSecurityLimit('maxSessions', 0)).toBe(false);
    expect(isValidSecurityLimit('maxSessions', 50)).toBe(true);
  });

  it('every schema enforces the bound it advertises', () => {
    for (const key of SECURITY_LIMIT_KEYS) {
      const b: { min: number; max?: number } = SECURITY_LIMIT_BOUNDS[key];
      expect(isValidSecurityLimit(key, b.min)).toBe(true);
      expect(isValidSecurityLimit(key, b.min - 1)).toBe(false);
      if (b.max !== undefined) {
        expect(isValidSecurityLimit(key, b.max)).toBe(true);
        expect(isValidSecurityLimit(key, b.max + 1)).toBe(false);
      }
    }
  });
});
