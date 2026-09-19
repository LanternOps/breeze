import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getEmailDomainsConfig, isPartnerLaneConfigured, findStaticAllowedEntry } from './config';

const KEYS = [
  'IS_HOSTED', 'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_STATIC_ALLOWED',
  'EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_RESEND_SENDING_KEY', 'EMAIL_DOMAINS_REGION',
  'EMAIL_DOMAINS_MAX_PER_PARTNER', 'EMAIL_DOMAINS_DAILY_SEND_CAP',
  'EMAIL_DOMAINS_PARTNER_ALLOWLIST', 'EMAIL_DOMAINS_DENYLIST', 'EMAIL_DOMAINS_WEBHOOK_SECRET',
  'EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE', 'EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES',
  'EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS'
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
  it('drops an entry with an empty domain or an empty slug after the colon, and WARNS on each', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = ':slug, acme.com:, ok.com';
    expect(getEmailDomainsConfig().staticAllowed).toEqual([{ domain: 'ok.com', partnerSlug: null }]);
    // A dropped entry is a domain the operator believes is allowed; silence
    // here is indistinguishable from "configured correctly".
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('":slug"');
    expect(lines[1]).toContain('"acme.com:"');
    warn.mockRestore();
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

describe('getEmailDomainsConfig — auto-suspension (spec §9.3)', () => {
  it('is ON with the spec defaults when hosted and nothing is set', () => {
    process.env.IS_HOSTED = 'true';
    expect(getEmailDomainsConfig().autoSuspend).toEqual({
      enabled: true, bounceRate: 0.08, minMessages: 50, complaints: 3,
    });
  });

  // The load-bearing self-hosted guarantee: an upgrade must not start
  // suspending an operator's only sending domain behind their back.
  it('is OFF when self-hosted and nothing is set', () => {
    process.env.IS_HOSTED = 'false';
    expect(getEmailDomainsConfig().autoSuspend.enabled).toBe(false);
  });

  it('is ON self-hosted as soon as the operator sets any one threshold', () => {
    process.env.IS_HOSTED = 'false';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS = '5';
    const cfg = getEmailDomainsConfig().autoSuspend;
    expect(cfg.enabled).toBe(true);
    expect(cfg.complaints).toBe(5);
    // The two the operator did NOT set fall back to the published defaults.
    expect(cfg.bounceRate).toBe(0.08);
    expect(cfg.minMessages).toBe(50);
  });

  it('reads all three thresholds', () => {
    process.env.IS_HOSTED = 'true';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE = '0.12';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES = '200';
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS = '10';
    expect(getEmailDomainsConfig().autoSuspend).toEqual({
      enabled: true, bounceRate: 0.12, minMessages: 200, complaints: 10,
    });
  });

  it('ignores a bounce rate outside (0, 1] and warns', () => {
    process.env.IS_HOSTED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE = '8';
    expect(getEmailDomainsConfig().autoSuspend.bounceRate).toBe(0.08);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores a non-numeric threshold and keeps the default', () => {
    process.env.IS_HOSTED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES = 'lots';
    expect(getEmailDomainsConfig().autoSuspend.minMessages).toBe(50);
    warn.mockRestore();
  });

  // 0 messages would make every partner with a single bounce suspendable.
  it('refuses minMessages = 0 and keeps the default', () => {
    process.env.IS_HOSTED = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES = '0';
    expect(getEmailDomainsConfig().autoSuspend.minMessages).toBe(50);
    warn.mockRestore();
  });
});
