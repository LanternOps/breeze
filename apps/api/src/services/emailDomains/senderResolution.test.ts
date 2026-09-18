import { describe, expect, it, vi } from 'vitest';
import { MAIL_PURPOSES, mailPurposePolicy, type MailPurpose } from './mailPurposes';
import { fromWithDisplayName, platformFallbackFrom, resolveSender } from './senderResolution';

// W04 TRIPWIRE. In W01 senderResolution imports nothing from the db layer, so
// this factory is never invoked and this mock cannot fail — it is stated here
// so that the moment W04 adds the partner-lane read, every assertion below
// (all of which are platform-lane inputs) proves the short-circuit still
// happens BEFORE any database access, which is spec §8.1's first property.
vi.mock('../../db', () => new Proxy({}, {
  get(_target, property) {
    if (typeof property === 'symbol') return undefined;
    throw new Error(`resolveSender touched the db module (.${String(property)}) on a platform-lane input`);
  },
}));

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
});
