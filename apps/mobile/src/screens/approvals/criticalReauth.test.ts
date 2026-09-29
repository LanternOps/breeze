import { describe, expect, it } from 'vitest';
import {
  buildReauthFactor,
  reauthErrorMessage,
  requiresCriticalReauth,
} from './criticalReauth';

describe('criticalReauth (#4052)', () => {
  it('requires re-auth only for the critical tier', () => {
    expect(requiresCriticalReauth('critical')).toBe(true);
    expect(requiresCriticalReauth('high')).toBe(false);
    expect(requiresCriticalReauth('medium')).toBe(false);
    expect(requiresCriticalReauth('low')).toBe(false);
  });

  it('builds a trimmed factor for the selected mode', () => {
    expect(buildReauthFactor('password', '  hunter2 ')).toEqual({ kind: 'password', value: 'hunter2' });
    expect(buildReauthFactor('totp', ' 123456')).toEqual({ kind: 'totp', value: '123456' });
  });

  it('builds nothing from an empty or whitespace entry', () => {
    expect(buildReauthFactor('password', '')).toBeUndefined();
    expect(buildReauthFactor('totp', '   ')).toBeUndefined();
  });

  it('has approver-facing copy for every re-auth failure code', () => {
    expect(reauthErrorMessage('REAUTH_REQUIRED')).toMatch(/password or authenticator code/i);
    expect(reauthErrorMessage('REAUTH_INVALID')).toMatch(/not accepted/i);
    expect(reauthErrorMessage('REAUTH_THROTTLED')).toMatch(/too many attempts/i);
    expect(reauthErrorMessage('REAUTH_UNAVAILABLE')).toMatch(/temporarily unavailable/i);
    expect(reauthErrorMessage('REAUTH_METHOD_NOT_PERMITTED')).toMatch(/use your password/i);
    expect(reauthErrorMessage('STEP_UP_REQUIRED')).toMatch(/approver device/i);
  });

  it('leaves unrelated decision errors to the caller', () => {
    expect(reauthErrorMessage('ALREADY_DECIDED')).toBeUndefined();
    expect(reauthErrorMessage('STEP_UP_FAILED')).toBeUndefined();
  });
});
