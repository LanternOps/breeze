import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertSendingDomainAllowed, SendingDomainPolicyError } from './domainPolicy';

const SAVED: Record<string, string | undefined> = {};
const KEYS = ['IS_HOSTED', 'EMAIL_FROM', 'TICKETS_INBOUND_DOMAIN', 'PUBLIC_APP_URL', 'EMAIL_DOMAINS_DENYLIST'];

beforeEach(() => {
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

function reasonOf(domain: string): string | null {
  try {
    assertSendingDomainAllowed(domain);
    return null;
  } catch (err) {
    if (err instanceof SendingDomainPolicyError) return err.reason;
    throw err;
  }
}

describe('assertSendingDomainAllowed — accepted', () => {
  it.each(['acme.com', 'mail.acme.com', 'acme.co.uk', 'deep.sub.acme.com', 'acme-msp.io'])(
    'accepts %s on a self-hosted instance',
    (domain) => {
      expect(reasonOf(domain)).toBeNull();
    },
  );

  it('accepts the EMAIL_FROM domain on a SELF-HOSTED instance — it IS the MSP domain', () => {
    process.env.EMAIL_FROM = 'support@acme.com';
    expect(reasonOf('acme.com')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — platform domains (hosted only)', () => {
  beforeEach(() => { process.env.IS_HOSTED = 'true'; });

  it.each(['2breeze.app', 'breezermm.com', 'lanternops.io', 'mail.2breeze.app', 'a.b.breezermm.com'])(
    'refuses the static platform domain %s',
    (domain) => {
      expect(reasonOf(domain)).toBe('platform_domain');
    },
  );

  it('refuses the EMAIL_FROM domain and its subdomains', () => {
    process.env.EMAIL_FROM = '"Breeze" <no-reply@send.breeze.example>';
    expect(reasonOf('send.breeze.example')).toBe('platform_domain');
    expect(reasonOf('x.send.breeze.example')).toBe('platform_domain');
  });

  it('refuses the TICKETS_INBOUND_DOMAIN', () => {
    process.env.TICKETS_INBOUND_DOMAIN = 'tickets.breeze.example';
    expect(reasonOf('tickets.breeze.example')).toBe('platform_domain');
  });

  it('refuses the PUBLIC_APP_URL host', () => {
    process.env.PUBLIC_APP_URL = 'https://app.breeze.example/path';
    expect(reasonOf('app.breeze.example')).toBe('platform_domain');
  });

  it('does not refuse a domain that merely ENDS WITH a platform name without a dot boundary', () => {
    expect(reasonOf('notbreezermm.com')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — platform domains do NOT apply self-hosted', () => {
  it('accepts the EMAIL_FROM domain when IS_HOSTED is unset', () => {
    process.env.EMAIL_FROM = 'support@acme.com';
    expect(reasonOf('acme.com')).toBeNull();
  });
  it('still refuses the Breeze-owned static list self-hosted', () => {
    // A self-hoster cannot prove ownership of 2breeze.app either.
    expect(reasonOf('2breeze.app')).toBe('platform_domain');
  });
});

describe('assertSendingDomainAllowed — consumer mailbox providers', () => {
  it.each(['gmail.com', 'outlook.com', 'yahoo.co.uk', 'icloud.com', 'proton.me'])(
    'refuses %s',
    (domain) => {
      expect(reasonOf(domain)).toBe('consumer_domain');
    },
  );
  it('does not refuse a subdomain of a consumer provider (exact-match set)', () => {
    expect(reasonOf('mail.gmail.com')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — public suffixes', () => {
  it.each(['com', 'co.uk', 'com.au', 'github.io', 'herokuapp.com'])(
    'refuses the registrable-boundary suffix %s',
    (domain) => {
      expect(reasonOf(domain)).toBe('public_suffix');
    },
  );
  it('accepts a name registered under one', () => {
    expect(reasonOf('acme.co.uk')).toBeNull();
    expect(reasonOf('acme.github.io')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — operator denylist', () => {
  it('refuses an exact entry', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = 'blocked.example, other.example';
    expect(reasonOf('blocked.example')).toBe('denylisted');
    expect(reasonOf('other.example')).toBe('denylisted');
  });
  it('refuses a subdomain of an entry', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = 'blocked.example';
    expect(reasonOf('mail.blocked.example')).toBe('denylisted');
  });
  it('is case- and whitespace-insensitive', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = '  BLOCKED.Example  ';
    expect(reasonOf('blocked.example')).toBe('denylisted');
  });
  it('leaves unrelated domains alone', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = 'blocked.example';
    expect(reasonOf('acme.com')).toBeNull();
  });
});

describe('rejection precedence', () => {
  it('reports platform_domain before anything else', () => {
    process.env.IS_HOSTED = 'true';
    process.env.EMAIL_DOMAINS_DENYLIST = '2breeze.app';
    expect(reasonOf('2breeze.app')).toBe('platform_domain');
  });
});
