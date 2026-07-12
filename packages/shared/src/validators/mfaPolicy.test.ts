import { describe, expect, it } from 'vitest';
import {
  getExplicitMfaAllowedMethods,
  hasMfaAllowedMethodsInput,
  mfaAllowedMethodsSchema,
  mfaSettingsSchema,
} from './mfaPolicy';

describe('mfa policy settings validators', () => {
  it('accepts every canonical primary factor including passkey', () => {
    expect(mfaAllowedMethodsSchema.parse({
      totp: true,
      sms: true,
      passkey: true,
    })).toEqual({ totp: true, sms: true, passkey: true });
  });

  it.each([
    {},
    { totp: false },
    { totp: false, sms: false, passkey: false },
  ])('rejects an explicit allowlist with no enabled primary factor: %j', (allowedMethods) => {
    expect(mfaAllowedMethodsSchema.safeParse(allowedMethods).success).toBe(false);
  });

  it('canonicalizes the legacy input alias and removes the second authority', () => {
    const parsed = mfaSettingsSchema.parse({
      branding: { primaryColor: '#123456' },
      security: {
        requireMfa: true,
        allowedMfaMethods: { passkey: true },
        sessionTimeout: 30,
      },
    });

    expect(parsed).toEqual({
      branding: { primaryColor: '#123456' },
      security: {
        requireMfa: true,
        allowedMethods: { passkey: true },
        sessionTimeout: 30,
      },
    });
    expect(parsed.security).not.toHaveProperty('allowedMfaMethods');
  });

  it('keeps the canonical value authoritative when both spellings are supplied', () => {
    const parsed = mfaSettingsSchema.parse({
      security: {
        allowedMethods: { totp: true },
        allowedMfaMethods: { unsupported: 'legacy garbage' },
      },
    });

    expect(parsed.security?.allowedMethods).toEqual({ totp: true });
    expect(parsed.security).not.toHaveProperty('allowedMfaMethods');
  });

  it('preserves settings without an MFA allowlist and reports whether one was supplied', () => {
    const settings = { security: { requireMfa: false, maxSessions: 4 } };
    expect(mfaSettingsSchema.parse(settings)).toEqual(settings);
    expect(hasMfaAllowedMethodsInput(settings)).toBe(false);
    expect(hasMfaAllowedMethodsInput({ security: { allowedMfaMethods: { sms: true } } })).toBe(true);
  });

  it('reads canonical and legacy stored allowlists with canonical precedence', () => {
    expect(getExplicitMfaAllowedMethods({ security: { allowedMethods: { totp: true, sms: false } } }))
      .toEqual(new Set(['totp']));
    expect(getExplicitMfaAllowedMethods({ security: { allowedMfaMethods: { sms: true } } }))
      .toEqual(new Set(['sms']));
    expect(getExplicitMfaAllowedMethods({
      security: {
        allowedMethods: { passkey: true },
        allowedMfaMethods: { sms: true },
      },
    })).toEqual(new Set(['passkey']));
  });

  it('fails closed when a stored explicit allowlist is malformed or empty', () => {
    expect(() => getExplicitMfaAllowedMethods({ security: { allowedMethods: {} } })).toThrow();
    expect(() => getExplicitMfaAllowedMethods({ security: { allowedMethods: ['totp'] } })).toThrow();
  });

  it.each([
    'corrupt',
    42,
    ['settings'],
    { security: 'corrupt' },
    { security: 42 },
    { security: ['totp'] },
  ])('fails closed for a malformed stored settings container: %j', (settings) => {
    expect(() => getExplicitMfaAllowedMethods(settings)).toThrow(/corrupt|invalid/i);
  });

  it.each([
    { security: { allowedMethods: 'totp' } },
    { security: { allowedMethods: 42 } },
    { security: { allowedMfaMethods: ['sms'] } },
    { security: { allowedMfaMethods: false } },
  ])('fails closed for a malformed canonical or legacy leaf: %j', (settings) => {
    expect(() => getExplicitMfaAllowedMethods(settings)).toThrow(/invalid/i);
  });

  it('still treats absent or null settings as unspecified', () => {
    expect(getExplicitMfaAllowedMethods(undefined)).toBeUndefined();
    expect(getExplicitMfaAllowedMethods(null)).toBeUndefined();
    expect(getExplicitMfaAllowedMethods({})).toBeUndefined();
    expect(getExplicitMfaAllowedMethods({ security: null })).toBeUndefined();
  });
});
