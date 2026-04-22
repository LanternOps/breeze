import { describe, it, expect } from 'vitest';
import { validateBusinessEmail, loadOverridesFromEnv } from './businessEmail';

describe('validateBusinessEmail', () => {
  it('accepts a business email', () => {
    expect(validateBusinessEmail('alex@acme.com')).toEqual({ ok: true });
  });

  const freeProviders = [
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'yahoo.com',
    'yahoo.co.uk',
    'icloud.com',
    'me.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
    'tutanota.com',
    'gmx.com',
    'yandex.ru',
    'mail.ru',
    'fastmail.com',
    'qq.com',
    '163.com',
    'naver.com',
  ];

  it.each(freeProviders)('rejects free provider %s', (domain) => {
    const result = validateBusinessEmail(`user@${domain}`);
    expect(result).toEqual({ ok: false, reason: 'free_provider' });
  });

  it('rejects a disposable provider', () => {
    const result = validateBusinessEmail('user@mailinator.com');
    expect(result).toEqual({ ok: false, reason: 'disposable' });
  });

  it('rejects malformed emails', () => {
    expect(validateBusinessEmail('not-an-email')).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
    expect(validateBusinessEmail('')).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
    expect(validateBusinessEmail('foo@')).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
    expect(validateBusinessEmail('@bar.com')).toEqual({
      ok: false,
      reason: 'invalid_format',
    });
  });

  it('honors alwaysAllow override', () => {
    const result = validateBusinessEmail('user@gmail.com', {
      alwaysAllow: ['gmail.com'],
    });
    expect(result).toEqual({ ok: true });
  });

  it('honors alwaysBlock override', () => {
    const result = validateBusinessEmail('user@acme.com', {
      alwaysBlock: ['acme.com'],
    });
    expect(result).toEqual({ ok: false, reason: 'blocked_override' });
  });

  it('case-insensitive domain match for free providers', () => {
    expect(validateBusinessEmail('User@GMAIL.com')).toEqual({
      ok: false,
      reason: 'free_provider',
    });
  });
});

describe('loadOverridesFromEnv', () => {
  it('parses allow and block lists from env', () => {
    const env = {
      BUSINESS_EMAIL_ALLOW: 'gmail.com, example.org',
      BUSINESS_EMAIL_BLOCK: 'evil.com',
    };
    const overrides = loadOverridesFromEnv(env);
    expect(overrides.alwaysAllow).toEqual(['gmail.com', 'example.org']);
    expect(overrides.alwaysBlock).toEqual(['evil.com']);
  });

  it('returns empty arrays when env vars absent', () => {
    const overrides = loadOverridesFromEnv({});
    expect(overrides.alwaysAllow).toEqual([]);
    expect(overrides.alwaysBlock).toEqual([]);
  });
});
