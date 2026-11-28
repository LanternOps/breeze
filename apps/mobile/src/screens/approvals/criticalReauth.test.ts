import { describe, expect, it } from 'vitest';
import {
  buildReauthFactor,
  needsReauthEntry,
  offersCodeEntry,
  reauthErrorMessage,
  secondFactorRefusalMessage,
  requiresCriticalReauth,
  secondFactorErrorMessage,
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

describe('second factor on approve', () => {
  it('asks for an authenticator code after the server asks for a second factor', () => {
    expect(reauthErrorMessage('MFA_REQUIRED')).toMatch(/authenticator app/i);
    expect(reauthErrorMessage('MFA_REQUIRED')).toMatch(/sign in again/i);
  });

  it('shows the entry for a critical request, or for any request the server asked a second factor for', () => {
    expect(needsReauthEntry('critical', false)).toBe(true);
    expect(needsReauthEntry('high', false)).toBe(false);
    expect(needsReauthEntry('high', true)).toBe(true);
    expect(needsReauthEntry('low', true)).toBe(true);
  });

  it('does not suggest a password when only a second factor will do', () => {
    expect(secondFactorErrorMessage('REAUTH_METHOD_NOT_PERMITTED')).toMatch(/sign in again/i);
    expect(secondFactorErrorMessage('REAUTH_METHOD_NOT_PERMITTED')).not.toMatch(/password/i);
    expect(secondFactorErrorMessage('MFA_REQUIRED')).toBe(reauthErrorMessage('MFA_REQUIRED'));
    expect(secondFactorErrorMessage('REAUTH_INVALID')).toMatch(/next code/i);
    expect(secondFactorErrorMessage('REAUTH_INVALID')).not.toMatch(/password/i);
    expect(secondFactorErrorMessage('REAUTH_THROTTLED')).toBe(reauthErrorMessage('REAUTH_THROTTLED'));
  });
});

describe('a second-factor refusal on an account with or without an authenticator app', () => {
  it('offers code entry only when the server takes a code from this account', () => {
    expect(offersCodeEntry(true)).toBe(true);
    expect(offersCodeEntry(false)).toBe(false);
    expect(offersCodeEntry(undefined)).toBe(false);
  });

  it('asks for a code when one can be used', () => {
    expect(secondFactorRefusalMessage(true)).toBe(reauthErrorMessage('MFA_REQUIRED'));
  });

  it('says how to get a second factor, and asks for no code, when none can be used', () => {
    for (const usable of [false, undefined]) {
      const text = secondFactorRefusalMessage(usable);
      expect(text).toMatch(/sign in again with your second factor/i);
      expect(text).toMatch(/set up an authenticator app/i);
      expect(text).not.toMatch(/enter the code/i);
    }
  });
});
