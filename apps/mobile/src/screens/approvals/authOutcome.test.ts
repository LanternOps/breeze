import { describe, expect, it } from 'vitest';
import { classifyAuthFailure } from './authOutcome';

describe('classifyAuthFailure', () => {
  it('treats an explicit user cancel as a silent no-op', () => {
    expect(classifyAuthFailure('user_cancel')).toEqual({
      kind: 'silent',
      message: null,
    });
  });

  it('surfaces system_cancel as an actionable retry (interrupted, not silent)', () => {
    const r = classifyAuthFailure('system_cancel');
    expect(r.kind).toBe('interrupted');
    expect(r.message).toBe('Confirmation was interrupted. Tap Approve to try again.');
  });

  it('surfaces app_cancel as an actionable retry (interrupted, not silent)', () => {
    const r = classifyAuthFailure('app_cancel');
    expect(r.kind).toBe('interrupted');
    expect(r.message).toMatch(/try again/i);
  });

  it('reports biometric lockout with a passcode hint', () => {
    for (const code of ['lockout', 'lockout_permanent']) {
      const r = classifyAuthFailure(code);
      expect(r.kind).toBe('lockout');
      expect(r.message).toMatch(/locked/i);
    }
  });

  it('falls back to a generic failure for unknown codes', () => {
    const r = classifyAuthFailure('authentication_failed');
    expect(r.kind).toBe('failed');
    expect(r.message).toBe('Authentication failed. Try again.');
  });

  it('falls back to a generic failure when the code is undefined (thrown/native error)', () => {
    const r = classifyAuthFailure(undefined);
    expect(r.kind).toBe('failed');
    expect(r.message).toBe('Authentication failed. Try again.');
  });

  it('never returns a null message except for the silent user_cancel case', () => {
    const codes = ['system_cancel', 'app_cancel', 'lockout', 'lockout_permanent', 'weird', undefined];
    for (const code of codes) {
      expect(classifyAuthFailure(code).message).not.toBeNull();
    }
  });
});
