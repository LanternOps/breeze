import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmailDomainProvider, resetEmailDomainProviderForTests } from './providerRegistry';

const KEYS = ['EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_RESEND_API_KEY', 'IS_HOSTED'];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  resetEmailDomainProviderForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!;
  }
  resetEmailDomainProviderForTests();
});

describe('getEmailDomainProvider', () => {
  it('returns null when EMAIL_DOMAINS_PROVIDER is unset — the switch that keeps W02 dark', () => {
    expect(getEmailDomainProvider()).toBeNull();
  });

  it('returns null for an empty string', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = '';
    expect(getEmailDomainProvider()).toBeNull();
  });

  it('returns the fake adapter', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    const provider = getEmailDomainProvider();
    expect(provider?.id).toBe('fake');
    expect(provider?.verifiesByDns).toBe(true);
  });

  it('returns the static adapter, which does not verify by DNS', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'static';
    const provider = getEmailDomainProvider();
    expect(provider?.id).toBe('static');
    expect(provider?.verifiesByDns).toBe(false);
  });

  it('returns the resend adapter when a key is present', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'resend';
    process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
    const provider = getEmailDomainProvider();
    expect(provider?.id).toBe('resend');
    expect(provider?.verifiesByDns).toBe(true);
  });

  it('returns null for resend WITHOUT a key instead of constructing a client that throws', () => {
    // `new Resend(undefined)` throws from the SDK constructor. Boot validation
    // already refuses this combination in production; a non-validating
    // entrypoint must degrade to "unsupported", never crash on first use.
    process.env.EMAIL_DOMAINS_PROVIDER = 'resend';
    expect(getEmailDomainProvider()).toBeNull();
  });

  it('caches the instance and resets on demand', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    const first = getEmailDomainProvider();
    expect(getEmailDomainProvider()).toBe(first);
    resetEmailDomainProviderForTests();
    expect(getEmailDomainProvider()).not.toBe(first);
  });
});
