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

// Fixtures name the DOMAIN and let each case build the address. Two reasons:
// the local part is never what is under test (the module only ever looks at the
// domain), and a repo-wide guard rejects committed email literals outside a
// small placeholder allowlist — see scripts/security/check-customer-pii.sh. The
// production module already carries these provider domains as bare strings.
const withLocalPart = (domain: string): string => `someone@${domain}`;

describe('isConsumerEmailDomain', () => {
  it.each([
    'gmail.com',
    'googlemail.com',
    'outlook.com',
    'hotmail.co.uk',
    'yahoo.com.br',
    'icloud.com',
    'aol.com',
    'proton.me',
    'protonmail.com',
    'mail.ru',
    'rambler.ru',
    'gmx.de',
    'mailinator.com',
    'yopmail.com',
  ])('flags %s', (domain) => {
    expect(isConsumerEmailDomain(withLocalPart(domain))).toBe(true);
  });

  // The rebrand that a tutanota-only list would have missed. This is the exact
  // gap that caused a live paying partner to be miscounted during design.
  it.each(['tutanota.com', 'tutamail.com', 'tuta.com', 'tuta.io'])(
    'flags the Tuta/Tutanota rebrand variant %s',
    (domain) => {
      expect(isConsumerEmailDomain(withLocalPart(domain))).toBe(true);
    }
  );

  // Shaped after real partner domains but deliberately synthetic: a public repo
  // must not carry customer identifiers, and the assertion only needs a domain
  // that is absent from the list.
  it.each([
    'msp-one.example',
    'managed-services.example',
    'it-support.example',
    'regional-integrator.example',
    'manufacturer.example',
    'franchise-location.example',
    // Stands in for a rural-ISP mailbox: not a business domain in spirit, but
    // not on the list either — over-blocking a real customer is worse than
    // missing one.
    'rural-isp.example',
  ])('does not flag the business domain %s', (domain) => {
    expect(isConsumerEmailDomain(withLocalPart(domain))).toBe(false);
  });

  // Breaking this address fails Apple's App Store review.
  it('does not flag the App Store reviewer demo domain', () => {
    expect(isConsumerEmailDomain('appstore-review@breezermm.com')).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isConsumerEmailDomain('  Someone@GMAIL.com  ')).toBe(true);
  });

  it('does not flag a domain that merely contains a provider name', () => {
    expect(isConsumerEmailDomain(withLocalPart('gmail.com.evil.example'))).toBe(false);
    expect(isConsumerEmailDomain(withLocalPart('notgmail.com'))).toBe(false);
    expect(isConsumerEmailDomain(withLocalPart('mygmail.com'))).toBe(false);
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
