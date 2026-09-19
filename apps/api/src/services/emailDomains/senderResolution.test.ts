import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAIL_PURPOSES, mailPurposePolicy, type MailPurpose } from './mailPurposes';
import { fromWithDisplayName, platformFallbackFrom, resolveSender } from './senderResolution';
import { getEmailDomainsConfig, isPartnerLaneConfigured } from './config';
import { lookupPartnerLaneIdentity } from './partnerLaneLookup';
import { tryCountPartnerLaneSend } from './sendCap';

// W01's property-throwing namespace Proxy, kept as a per-EXPORT tripwire now
// that W04 has a partner branch that legitimately reads the database. Every
// assertion in this file is a platform-lane input, so any of these firing means
// the short-circuit of spec §8.1 regressed. `partnerLaneLookup` is mocked
// separately, per test, for the partner cases.
vi.mock('../../db', () => ({
  db: new Proxy({}, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined;
      throw new Error(`resolveSender queried the db (db.${String(property)}) on a platform-lane input`);
    },
  }),
  getCurrentDbAccessContext: () => { throw new Error('resolveSender inspected the db context on a platform-lane input'); },
  runOutsideDbContext: () => { throw new Error('resolveSender left the db context on a platform-lane input'); },
  withSystemDbAccessContext: () => { throw new Error('resolveSender opened a system context on a platform-lane input'); },
}));

// A full EmailDomainsConfig: the partner branch reads only `partnerAllowlist`
// and (through sendCap, which is mocked separately) `dailySendCap`, but the
// return type is the whole record, so the rest is spelled out once here rather
// than cast away at each mockReturnValue.
const { domainsConfigFixture } = vi.hoisted(() => ({
  domainsConfigFixture: (over: { dailySendCap?: number; partnerAllowlist?: string[] } = {}) => ({
    provider: 'fake' as const,
    resendApiKey: null,
    resendSendingKey: null,
    region: 'us-east-1',
    maxPerPartner: 3,
    dailySendCap: 0,
    partnerAllowlist: [] as string[],
    denylist: [] as string[],
    staticAllowed: [],
    webhookSecret: null,
    // W06 widened EmailDomainsConfig; senderResolution never reads it, but the
    // fixture has to satisfy the type.
    autoSuspend: { enabled: false, bounceRate: 0.08, minMessages: 50, complaints: 3 },
    ...over,
  }),
}));

vi.mock('./config', () => ({
  isPartnerLaneConfigured: vi.fn(() => true),
  getEmailDomainsConfig: vi.fn(() => domainsConfigFixture()),
}));
vi.mock('./partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: vi.fn() }));
vi.mock('./sendCap', () => ({ tryCountPartnerLaneSend: vi.fn(async () => true) }));

const laneConfigured = vi.mocked(isPartnerLaneConfigured);
const domainsConfig = vi.mocked(getEmailDomainsConfig);
const lookup = vi.mocked(lookupPartnerLaneIdentity);
const cap = vi.mocked(tryCountPartnerLaneSend);

const DEFAULT_FROM = 'Breeze <no-reply@2breeze.app>';
const ALL_PURPOSES = Object.keys(MAIL_PURPOSES) as MailPurpose[];
const PLATFORM_PURPOSES = ALL_PURPOSES.filter((p) => mailPurposePolicy(p).lane === 'platform');
const PARTNER_PURPOSES = ALL_PURPOSES.filter((p) => mailPurposePolicy(p).lane === 'partner');

describe('fromWithDisplayName (moved verbatim off EmailService, spec §0.3)', () => {
  it('wraps the default address with a quoted display name', () => {
    expect(fromWithDisplayName('noreply@example.com', 'Acme MSP via Breeze'))
      .toBe('"Acme MSP via Breeze" <noreply@example.com>');
  });

  it('extracts the address when the default already carries a display name', () => {
    expect(fromWithDisplayName('Breeze <noreply@example.com>', 'Acme MSP via Breeze'))
      .toBe('"Acme MSP via Breeze" <noreply@example.com>');
  });

  it('strips header-breaking characters from the display name', () => {
    expect(fromWithDisplayName('noreply@example.com', 'Evil"\r\nBcc: victim <x>'))
      .toBe('"Evil Bcc: victim x" <noreply@example.com>');
  });

  it('falls back to the default sender when the name is empty after sanitizing', () => {
    expect(fromWithDisplayName('noreply@example.com', '"<>"')).toBe('noreply@example.com');
  });

  it('falls back to the default sender when it carries no address at all', () => {
    expect(fromWithDisplayName('not-an-address', 'Acme MSP')).toBe('not-an-address');
  });
});

describe('platformFallbackFrom (spec §8.3)', () => {
  it('returns the bare default for every purpose except quote.sent and invoice.sent', () => {
    for (const purpose of ALL_PURPOSES) {
      if (purpose === 'quote.sent' || purpose === 'invoice.sent') continue;
      expect(platformFallbackFrom(purpose, DEFAULT_FROM, 'Acme MSP')).toBe(DEFAULT_FROM);
    }
  });

  it('brands quote.sent and invoice.sent with "<Partner> via Breeze"', () => {
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, 'Acme MSP'))
      .toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');
    expect(platformFallbackFrom('invoice.sent', DEFAULT_FROM, 'Acme MSP'))
      .toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');
  });

  // Byte-identity with the pre-W01 call sites, which read
  // `partnerName ? fromWithDisplayName(...) : undefined` — a falsy name meant
  // the bare default, and an all-whitespace name did NOT.
  it('falls back to the bare default when the partner name is missing or empty', () => {
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, null)).toBe(DEFAULT_FROM);
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, undefined)).toBe(DEFAULT_FROM);
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, '')).toBe(DEFAULT_FROM);
  });

  it('keeps an all-whitespace partner name branded, exactly as the old call sites did', () => {
    expect(platformFallbackFrom('quote.sent', DEFAULT_FROM, '   '))
      .toBe('"via Breeze" <no-reply@2breeze.app>');
  });
});

describe('resolveSender (W01: always the platform lane)', () => {
  // W01 asserted `lane_unconfigured` for a partner purpose with a partner. That
  // is still exactly what it asserts — the lane being OFF — so the block pins
  // the switch rather than relying on the new mock's default.
  beforeEach(() => {
    vi.clearAllMocks();
    laneConfigured.mockReturnValue(false);
  });

  it('returns platform_purpose for every platform purpose, whatever partnerId is passed', async () => {
    for (const purpose of PLATFORM_PURPOSES) {
      for (const partnerId of [null, 'partner-1']) {
        const resolved = await resolveSender({ purpose, partnerId, defaultFrom: DEFAULT_FROM });
        expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'platform_purpose' });
      }
    }
  });

  it('returns no_partner for a partner purpose with a null partnerId', async () => {
    for (const purpose of PARTNER_PURPOSES) {
      const resolved = await resolveSender({ purpose, partnerId: null, defaultFrom: DEFAULT_FROM });
      expect(resolved.lane).toBe('platform');
      expect(resolved.lane === 'platform' && resolved.reason).toBe('no_partner');
    }
  });

  it('returns lane_unconfigured for a partner purpose with a partner — the lane does not exist until W04', async () => {
    for (const purpose of PARTNER_PURPOSES) {
      const resolved = await resolveSender({ purpose, partnerId: 'partner-1', defaultFrom: DEFAULT_FROM });
      expect(resolved.lane).toBe('platform');
      expect(resolved.lane === 'platform' && resolved.reason).toBe('lane_unconfigured');
    }
  });

  it('carries the purpose fallback From onto the platform result', async () => {
    const branded = await resolveSender({
      purpose: 'invoice.sent', partnerId: 'partner-1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM,
    });
    expect(branded.from).toBe('"Acme MSP via Breeze" <no-reply@2breeze.app>');

    const plain = await resolveSender({
      purpose: 'ticket.customer_notification', partnerId: 'partner-1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM,
    });
    expect(plain.from).toBe(DEFAULT_FROM);
  });

  // A purpose outside the registry can only reach here by bypassing TypeScript
  // (a stale build, an `any`, a cast) — mailPurposePolicy already fails open to
  // the platform lane (mailPurposes.test.ts), but that must not happen quietly:
  // an unclassified send reaching production is exactly the failure mode G5's
  // compile-time guard exists to prevent, so it needs to show up in logs.
  it('warns and routes to the platform lane when the purpose is not in the registry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = 'nope.unknown' as MailPurpose;

    const resolved = await resolveSender({ purpose: unknown, partnerId: null, defaultFrom: DEFAULT_FROM });

    expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'platform_purpose' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[email] unknown mail purpose %s — routed to the platform lane', unknown);
    warn.mockRestore();
  });
});

const OK_IDENTITY = {
  ok: true as const, partnerName: 'Acme MSP', localPart: 'support', displayName: null,
  replyTo: null, domainId: 'd1', domain: 'mail.acme.test',
};

describe('resolveSender — the partner branch (spec §8.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    laneConfigured.mockReturnValue(true);
    domainsConfig.mockReturnValue(domainsConfigFixture());
    lookup.mockResolvedValue(OK_IDENTITY);
    cap.mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns the partner lane when every condition holds', async () => {
    await expect(resolveSender({
      purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM,
    })).resolves.toEqual({
      // Spec §8.3: the From is `"<display_name or partner name>" <local@domain>`.
      // OK_IDENTITY has no display name, so the partner name is used — the same
      // answer the "display name, else partner name" case below pins.
      lane: 'partner', from: '"Acme MSP" <support@mail.acme.test>', replyTo: null,
      partnerId: 'p1', domainId: 'd1', domain: 'mail.acme.test', stream: 'support',
    });
  });

  it('asks for the stream the purpose declares', async () => {
    await resolveSender({ purpose: 'invoice.sent', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(lookup).toHaveBeenCalledWith('p1', 'billing');
    await resolveSender({ purpose: 'report.delivery', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(lookup).toHaveBeenLastCalledWith('p1', 'general');
  });

  // Condition 1a: the lane is off. This is the DARK state of W02/W04 on every
  // deployment until an operator sets EMAIL_DOMAINS_PROVIDER.
  it('returns lane_unconfigured, before any lookup, when the lane is off', async () => {
    laneConfigured.mockReturnValue(false);
    const resolved = await resolveSender({ purpose: 'quote.sent', partnerId: 'p1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM });
    expect(resolved).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'lane_unconfigured' });
    expect(lookup).not.toHaveBeenCalled();
    expect(cap).not.toHaveBeenCalled();
  });

  // Condition 1b: the dark-launch allowlist (spec §9.1).
  it('honours EMAIL_DOMAINS_PARTNER_ALLOWLIST and does not read for an excluded partner', async () => {
    domainsConfig.mockReturnValue(domainsConfigFixture({ partnerAllowlist: ['p-other'] }));
    const resolved = await resolveSender({ purpose: 'portal.invite', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'not_allowlisted' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an EMPTY allowlist means every eligible partner', async () => {
    domainsConfig.mockReturnValue(domainsConfigFixture());
    expect((await resolveSender({ purpose: 'portal.invite', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).lane).toBe('partner');
  });

  it('maps each lookup refusal to its own reason', async () => {
    for (const reason of ['partner_ineligible', 'no_identity', 'domain_not_sendable'] as const) {
      lookup.mockResolvedValue({ ok: false, reason });
      const resolved = await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
      expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason });
    }
  });

  // Condition 4 runs LAST so an ineligible partner never burns a counter slot.
  it('checks the cap only after the lookup succeeds', async () => {
    lookup.mockResolvedValue({ ok: false, reason: 'no_identity' });
    await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(cap).not.toHaveBeenCalled();
  });

  it('returns over_cap when the cap refuses, with the purpose fallback From', async () => {
    cap.mockResolvedValue(false);
    const resolved = await resolveSender({ purpose: 'invoice.sent', partnerId: 'p1', partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM });
    expect(resolved).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'over_cap' });
  });

  it('builds the From from the identity display name, else the partner name', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: 'Acme Support' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('"Acme Support" <support@mail.acme.test>');

    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: null, partnerName: 'Acme MSP' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('"Acme MSP" <support@mail.acme.test>');
  });

  it('strips header-breaking characters from the display name, exactly as fromWithDisplayName does', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: 'Evil"\r\nBcc: victim <x>' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('"Evil Bcc: victim x" <support@mail.acme.test>');
  });

  it('falls back to the bare address when nothing usable survives sanitising', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, displayName: '"<>"', partnerName: '  ' });
    expect((await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM })).from)
      .toBe('support@mail.acme.test');
  });

  it('carries the identity reply-to onto the partner result', async () => {
    lookup.mockResolvedValue({ ...OK_IDENTITY, replyTo: 'help@acme.test' });
    const resolved = await resolveSender({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM });
    expect(resolved.lane === 'partner' && resolved.replyTo).toBe('help@acme.test');
  });

  it('still short-circuits a platform purpose and a null partner with the lane ON', async () => {
    for (const purpose of PLATFORM_PURPOSES) {
      const resolved = await resolveSender({ purpose, partnerId: 'p1', defaultFrom: DEFAULT_FROM });
      expect(resolved).toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'platform_purpose' });
    }
    const nullPartner = await resolveSender({ purpose: 'quote.sent', partnerId: null, partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM });
    expect(nullPartner).toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'no_partner' });
    expect(lookup).not.toHaveBeenCalled();
    expect(laneConfigured).not.toHaveBeenCalled();
  });
});

/**
 * The db tripwire, exercised against the REAL `partnerLaneLookup`.
 *
 * Every case above mocks `./partnerLaneLookup`, so the `../../db` tripwire can
 * never fire there however badly the resolver regresses — the module that would
 * touch the database is a stub. These cases unmock it, so the production lookup
 * (and therefore `db`, `getCurrentDbAccessContext` and the partner-axis read) is
 * genuinely in the graph, and each throwing export of the db mock becomes a live
 * assertion that a PLATFORM-lane input never reaches any of them (spec §8.1).
 */
describe('resolveSender — the db tripwire against the real lookup', () => {
  async function realResolveSender() {
    vi.resetModules();
    vi.doUnmock('./partnerLaneLookup');
    const mod = await import('./senderResolution');
    return mod.resolveSender;
  }

  afterEach(() => {
    vi.doMock('./partnerLaneLookup', () => ({ lookupPartnerLaneIdentity: vi.fn() }));
    vi.resetModules();
  });

  it('never touches the db module for a platform purpose, with a partner id supplied', async () => {
    const resolve = await realResolveSender();
    for (const purpose of PLATFORM_PURPOSES) {
      await expect(resolve({ purpose, partnerId: 'p1', defaultFrom: DEFAULT_FROM }))
        .resolves.toEqual({ lane: 'platform', from: DEFAULT_FROM, reason: 'platform_purpose' });
    }
  });

  it('never touches the db module for a partner purpose with no partner', async () => {
    const resolve = await realResolveSender();
    await expect(resolve({ purpose: 'quote.sent', partnerId: null, partnerName: 'Acme MSP', defaultFrom: DEFAULT_FROM }))
      .resolves.toEqual({ lane: 'platform', from: '"Acme MSP via Breeze" <no-reply@2breeze.app>', reason: 'no_partner' });
  });

  // The control: with the lane ON and a partner supplied, the resolver DOES
  // reach the real lookup, which touches db — so the tripwire fires. This is
  // what proves the two cases above are not vacuous.
  it('DOES reach the db module once the partner branch is entered (the control)', async () => {
    const resolve = await realResolveSender();
    await expect(resolve({ purpose: 'ticket.customer_notification', partnerId: 'p1', defaultFrom: DEFAULT_FROM }))
      .rejects.toThrow(/platform-lane input/);
  });
});
