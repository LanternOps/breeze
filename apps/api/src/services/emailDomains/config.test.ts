import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmailDomainsConfig, isPartnerLaneConfigured, findStaticAllowedEntry } from './config';

const KEYS = [
  'IS_HOSTED', 'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_STATIC_ALLOWED',
  'EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_RESEND_SENDING_KEY', 'EMAIL_DOMAINS_REGION',
  'EMAIL_DOMAINS_MAX_PER_PARTNER', 'EMAIL_DOMAINS_DAILY_SEND_CAP',
  'EMAIL_DOMAINS_PARTNER_ALLOWLIST', 'EMAIL_DOMAINS_DENYLIST', 'EMAIL_DOMAINS_WEBHOOK_SECRET'
];
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!;
  }
});

describe('getEmailDomainsConfig — defaults', () => {
  it('is off with everything unset', () => {
    const cfg = getEmailDomainsConfig();
    expect(cfg.provider).toBeNull();
    expect(isPartnerLaneConfigured()).toBe(false);
  });
  it('treats an empty string as unset (compose maps ${VAR:-})', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = '';
    expect(getEmailDomainsConfig().provider).toBeNull();
  });
  it('ignores an unrecognised value rather than throwing (boot validation already refused it)', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'mailgun';
    expect(getEmailDomainsConfig().provider).toBeNull();
  });
  it('defaults region to us-east-1 and maxPerPartner to 3', () => {
    const cfg = getEmailDomainsConfig();
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.maxPerPartner).toBe(3);
  });
  it('defaults the daily send cap to 2000 hosted and unlimited self-hosted', () => {
    process.env.IS_HOSTED = 'true';
    expect(getEmailDomainsConfig().dailySendCap).toBe(2000);
    process.env.IS_HOSTED = 'false';
    expect(getEmailDomainsConfig().dailySendCap).toBe(0);
  });
  it('treats 0 as unlimited and rejects a non-numeric override by falling back', () => {
    process.env.IS_HOSTED = 'true';
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
    expect(getEmailDomainsConfig().dailySendCap).toBe(0);
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = 'lots';
    expect(getEmailDomainsConfig().dailySendCap).toBe(2000);
  });
});

describe('getEmailDomainsConfig — keys and lists', () => {
  it('falls the sending key back to the management key', () => {
    process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
    const cfg = getEmailDomainsConfig();
    expect(cfg.resendApiKey).toBe('re_full');
    expect(cfg.resendSendingKey).toBe('re_full');
  });
  it('uses a distinct sending key when given', () => {
    process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
    process.env.EMAIL_DOMAINS_RESEND_SENDING_KEY = 're_send';
    expect(getEmailDomainsConfig().resendSendingKey).toBe('re_send');
  });
  it('parses the partner allowlist and the denylist', () => {
    process.env.EMAIL_DOMAINS_PARTNER_ALLOWLIST = ' p1 , p2 ,, ';
    process.env.EMAIL_DOMAINS_DENYLIST = 'Blocked.Example , other.example.';
    const cfg = getEmailDomainsConfig();
    expect(cfg.partnerAllowlist).toEqual(['p1', 'p2']);
    expect(cfg.denylist).toEqual(['blocked.example', 'other.example']);
  });
});

describe('EMAIL_DOMAINS_STATIC_ALLOWED parsing', () => {
  it('parses bare and partner-bound entries', () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'acme.com, Other.COM:other-slug , ';
    expect(getEmailDomainsConfig().staticAllowed).toEqual([
      { domain: 'acme.com', partnerSlug: null },
      { domain: 'other.com', partnerSlug: 'other-slug' }
    ]);
  });
  it('drops an entry with an empty domain or an empty slug after the colon', () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = ':slug, acme.com:, ok.com';
    expect(getEmailDomainsConfig().staticAllowed).toEqual([{ domain: 'ok.com', partnerSlug: null }]);
  });
});

describe('findStaticAllowedEntry', () => {
  beforeEach(() => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'open.com, bound.com:acme';
  });
  it('matches an unbound entry for any partner', () => {
    expect(findStaticAllowedEntry('open.com', 'anyone')).toEqual({ domain: 'open.com', partnerSlug: null });
    expect(findStaticAllowedEntry('open.com', null)).toEqual({ domain: 'open.com', partnerSlug: null });
  });
  it('matches a bound entry only for its partner', () => {
    expect(findStaticAllowedEntry('bound.com', 'acme')).toEqual({ domain: 'bound.com', partnerSlug: 'acme' });
    expect(findStaticAllowedEntry('bound.com', 'other')).toBeNull();
    expect(findStaticAllowedEntry('bound.com', null)).toBeNull();
  });
  it('does not match a subdomain or an unlisted domain', () => {
    expect(findStaticAllowedEntry('mail.open.com', 'anyone')).toBeNull();
    expect(findStaticAllowedEntry('nope.com', 'anyone')).toBeNull();
  });
});

describe('isPartnerLaneConfigured', () => {
  it.each(['resend', 'static', 'fake'])('is true for %s', (provider) => {
    process.env.EMAIL_DOMAINS_PROVIDER = provider;
    expect(isPartnerLaneConfigured()).toBe(true);
  });
});
