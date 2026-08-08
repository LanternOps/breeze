import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  emailDomainOf,
  isConsumerEmailDomain,
  businessEmailRequired,
  businessEmailContactUrl,
} from './consumerEmailDomains';

const ENV_KEYS = [
  'SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS',
  'SIGNUP_ALLOWED_EMAIL_DOMAINS',
  'SIGNUP_REQUIRE_BUSINESS_EMAIL',
  'SIGNUP_BUSINESS_EMAIL_CONTACT_URL',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('emailDomainOf', () => {
  it('extracts and lowercases the domain', () => {
    expect(emailDomainOf('Someone@Example.COM')).toBe('example.com');
  });

  it('uses the LAST @ so a quoted local part cannot smuggle a domain', () => {
    expect(emailDomainOf('"a@gmail.com"@corp.example')).toBe('corp.example');
  });

  it('strips a trailing root dot', () => {
    expect(emailDomainOf('a@gmail.com.')).toBe('gmail.com');
  });

  it('returns empty for malformed input rather than throwing', () => {
    expect(emailDomainOf('no-at-sign')).toBe('');
    expect(emailDomainOf('trailing@')).toBe('');
  });
});

describe('isConsumerEmailDomain', () => {
  it.each([
    'a@gmail.com',
    'a@googlemail.com',
    'a@outlook.com',
    'a@hotmail.co.uk',
    'a@yahoo.com.br',
    'a@icloud.com',
    'a@aol.com',
    'a@proton.me',
    'a@protonmail.com',
    'a@mail.ru',
    'a@rambler.ru',
    'a@gmx.de',
    'a@mailinator.com',
    'a@yopmail.com',
  ])('flags %s', (email) => {
    expect(isConsumerEmailDomain(email)).toBe(true);
  });

  // The rebrand that a tutanota-only list would have missed. This is the exact
  // gap that caused a live paying partner to be miscounted during design.
  it.each(['a@tutanota.com', 'a@tutamail.com', 'a@tuta.com', 'a@tuta.io'])(
    'flags the Tuta/Tutanota rebrand variant %s',
    (email) => {
      expect(isConsumerEmailDomain(email)).toBe(true);
    }
  );

  it.each([
    'clozano@comtodo.com',
    'sylvain@informatiquerimouski.com',
    'sebastian.dohse@advanced-it.eu',
    'admin@nexusitsys.com',
    'contato@concretcimento.com.br',
    'hbmyrtlebeach.isr@glassdoctor.com',
    // A rural-ISP mailbox. Not a business domain in spirit, but not on the list
    // either — over-blocking a real customer is worse than missing one.
    'gremaux@midrivers.com',
  ])('does not flag the real customer domain %s', (email) => {
    expect(isConsumerEmailDomain(email)).toBe(false);
  });

  // Breaking this address fails Apple's App Store review.
  it('does not flag the App Store reviewer demo domain', () => {
    expect(isConsumerEmailDomain('appstore-review@breezermm.com')).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isConsumerEmailDomain('  Someone@GMAIL.com  ')).toBe(true);
  });

  it('does not flag a domain that merely contains a provider name', () => {
    expect(isConsumerEmailDomain('a@gmail.com.evil.example')).toBe(false);
    expect(isConsumerEmailDomain('a@notgmail.com')).toBe(false);
    expect(isConsumerEmailDomain('a@mygmail.com')).toBe(false);
  });

  it('returns false for a malformed address instead of throwing', () => {
    expect(isConsumerEmailDomain('garbage')).toBe(false);
  });

  it('honours additive extras from env', () => {
    expect(isConsumerEmailDomain('a@newprovider.example')).toBe(false);
    process.env.SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS = 'newprovider.example, other.example';
    expect(isConsumerEmailDomain('a@newprovider.example')).toBe(true);
    expect(isConsumerEmailDomain('a@other.example')).toBe(true);
  });

  it('lets the allowlist override both the built-in list and the extras', () => {
    process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS = 'gmail.com';
    expect(isConsumerEmailDomain('a@gmail.com')).toBe(false);

    process.env.SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS = 'stuck.example';
    process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS = 'stuck.example';
    expect(isConsumerEmailDomain('a@stuck.example')).toBe(false);
  });
});

describe('businessEmailRequired', () => {
  it('is off for self-hosted regardless of env', () => {
    expect(businessEmailRequired(false)).toBe(false);
    process.env.SIGNUP_REQUIRE_BUSINESS_EMAIL = 'true';
    expect(businessEmailRequired(false)).toBe(false);
  });

  it('defaults on when hosted', () => {
    expect(businessEmailRequired(true)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ' off '])(
    'is disabled by the explicit kill switch %s',
    (value) => {
      process.env.SIGNUP_REQUIRE_BUSINESS_EMAIL = value;
      expect(businessEmailRequired(true)).toBe(false);
    }
  );

  it('stays on for unrecognized values', () => {
    process.env.SIGNUP_REQUIRE_BUSINESS_EMAIL = 'maybe';
    expect(businessEmailRequired(true)).toBe(true);
  });
});

describe('businessEmailContactUrl', () => {
  it('falls back to a default', () => {
    expect(businessEmailContactUrl()).toMatch(/^https:\/\//);
  });

  it('is overridable', () => {
    process.env.SIGNUP_BUSINESS_EMAIL_CONTACT_URL = 'https://cal.example/breeze';
    expect(businessEmailContactUrl()).toBe('https://cal.example/breeze');
  });
});
